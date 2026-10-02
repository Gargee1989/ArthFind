"""Extract a complete meaning from a JSON prefix without exposing raw tokens."""

import json

from backend.exceptions import DefinitionUnavailableException


class MeaningPreview:
    def __init__(self, callback=None):
        self.callback = callback
        self.text = ""
        self.sent = False

    def add(self, fragment):
        self.text += fragment
        # Bound malformed or runaway provider output as well as parsing work.
        if len(self.text) > 100_000:
            raise DefinitionUnavailableException()
        if not self.callback or self.sent:
            return
        text = self.text.lstrip()
        if text.startswith("```json"):
            text = text[7:].lstrip()
        elif text.startswith("```"):
            text = text[3:].lstrip()
        if not text.startswith("{"):
            return
        decoder = json.JSONDecoder()
        fields = {}
        pos = 1
        try:
            while True:
                while pos < len(text) and text[pos].isspace():
                    pos += 1
                key, pos = decoder.raw_decode(text, pos)
                if not isinstance(key, str) or key in fields:
                    return
                while pos < len(text) and text[pos].isspace():
                    pos += 1
                if pos >= len(text) or text[pos] != ":":
                    return
                pos += 1
                while pos < len(text) and text[pos].isspace():
                    pos += 1
                value, pos = decoder.raw_decode(text, pos)
                fields[key] = value
                meaning = fields.get("meaning")
                if fields.get("status") == "success" and isinstance(meaning, str) and 0 < len(meaning.strip()) <= 2000:
                    self.sent = True
                    self.callback(meaning)
                    return
                while pos < len(text) and text[pos].isspace():
                    pos += 1
                if pos >= len(text) or text[pos] != ",":
                    return
                pos += 1
        except (ValueError, IndexError):
            return  # Incomplete JSON; wait for another chunk.
