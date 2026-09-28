# Arth.Find

The best way to learn is to read. And what every reader wants is to read without disturbance.

We all imagine a calm, safe place to read: an aesthetic room, a quiet garden, an Edinburgh library. But real life isn't like that. Our spaces aren't always beautiful, and we can't buy a new book every time. PDFs solved the access problem by letting us read any material, anywhere, but they left two things behind:

1. The space we imagined. Standard PDF readers give you a blank white or black page, hard on the eyes and easy to forget.
2. The dictionary. What happens when a word shows up that you don't know?

Your brain does the obvious first thing: it uses the surrounding words to guess the meaning. But when that fails, you're forced to leave the page and search. And here's the catch: Google doesn't know what you're reading.

Take the phrase "Silicon Valley." Highlight just "Silicon" and Google will happily tell you it's a chemical element. But in your book, it's a place. A single word can carry many meanings. It's all about context.

## The Solution

Arth.Find gives readers both things they were missing: a contextual meaning engine and a calming, personal reading space, all in one place, right on your PDF.

### Contextual Meanings

Highlight a word, a phrase, or even a whole sentence, and Arth.Find explains what it means in the context of what you're reading. No new tabs. No interruptions.

Highlight "Silicon" and your royal assistant tells you:

> "Sir, in your source this refers to Silicon Valley, a region in California known as a global hub for technology."

Powered by an LLM that reads the surrounding text, Arth.Find gives you the meaning that fits, not just the meaning that's most common.

### Calming Themes

Say goodbye to blank white and black backgrounds. Arth.Find offers themes with colors chosen based on research into human psychology and what is calming to the eyes. Pick your favorite and read in comfort.

### Your Own Reading Space

We can't hand you a garden or a library, but we can bring one to your screen.

- Wallpapers: Choose from a collection of calming nature backgrounds.
- Custom backgrounds: Upload your own favorite images and make the reader truly yours.

Your garden. Your aesthetic room. Your Edinburgh library. Virtually, on every page.

## Features

- Context-aware meanings for words, phrases, and sentences
- Works directly on the page, with no tab switching
- Psychology-informed calming themes
- Built-in wallpapers with nature backgrounds
- Upload your own custom backgrounds
- Built-in PDF reader (local files or URLs)

## PDF Reader

Open the extension popup and choose "Open PDF reader". Select a local PDF or enter a PDF URL to open it in the bundled PDF.js viewer. Any text rendered by the viewer can be selected to trigger an Arth.Find lookup.

## Backend

The official backend is the Python FastAPI app in backend/app.py.

Run it from the project root:

    uvicorn backend.app:app --reload --port 8000

The extension connects to the backend endpoint configured in extension/crypto.js (BACKEND_ENDPOINT). For local development it defaults to:

    http://127.0.0.1:8000/define

### How it works

The extension sends POST /define with `word` and `context`. The backend accepts the word aliases used by the extension and returns a response containing `meaning`, which the extension displays as the explanation.

Provider API calls happen only in the backend. The extension never receives or sends Gemini, OpenAI, or NVIDIA provider keys.

### Supported providers

The backend supports Google Gemini, OpenAI, and NVIDIA NIM. Configure the fallback provider key and model in backend/.env or in your deployment environment.

### Bring Your Own Key (BYOK)

In BYOK mode, the extension sends the user's provider key once to POST /credentials. The backend encrypts the key with CREDENTIAL_ENCRYPTION_KEY and returns an opaque credential reference. Subsequent /define requests send only that reference, and provider keys never return to the extension after registration.

---

Arth.Find: because the right meaning depends on where you find the word.
