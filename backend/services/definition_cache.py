"""Bounded, process-local answer cache. No keys or reading text on disk."""

from collections import OrderedDict
from concurrent.futures import Future
from threading import Lock
from time import monotonic

from backend.schemas import DefineResponse


class DefinitionCache:
    def __init__(self, max_entries=256, ttl_seconds=300):
        self.max_entries = max_entries
        self.ttl_seconds = ttl_seconds
        self._entries = OrderedDict()
        self._pending = {}
        self._lock = Lock()

    def get_or_compute(self, key, compute):
        if self.max_entries <= 0 or self.ttl_seconds <= 0:
            return compute()
        with self._lock:
            now = monotonic()
            for expired in [k for k, (expiry, _) in self._entries.items() if expiry <= now]:
                del self._entries[expired]
            if key in self._entries:
                self._entries.move_to_end(key)
                return self._entries[key][1].model_copy(deep=True)
            future = self._pending.get(key)
            owner = future is None
            if owner:
                future = self._pending[key] = Future()
        if not owner:
            return future.result().model_copy(deep=True)
        try:
            result: DefineResponse = compute()
            with self._lock:
                self._entries[key] = (monotonic() + self.ttl_seconds, result.model_copy(deep=True))
                while len(self._entries) > self.max_entries:
                    self._entries.popitem(last=False)
            future.set_result(result.model_copy(deep=True))
            return result
        except BaseException as error:
            future.set_exception(error)
            raise
        finally:
            with self._lock:
                self._pending.pop(key, None)

    def clear(self):
        with self._lock:
            self._entries.clear()
