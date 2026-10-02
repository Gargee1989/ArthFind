# Arth.Find

---

## PROLOGUE: The Room That Doesn't Exist

Every reader has a place they carry in their mind.

Maybe it is a quiet room with warm light falling across a wooden desk. Maybe it is a garden at dawn, the air still, a book open on your knee. Maybe it is the great hall of an Edinburgh library, where the only sound is a turning page and the whole world feels far away.

We imagine these places because we understand something deep: the best way to learn is to read, and reading works best when nothing disturbs it.

Now look up from the daydream.

You are on a crowded train, or in a noisy hostel, or at a desk with a dozen tabs glaring at you. The real world is not an aesthetic space. And you cannot buy a new book every time your curiosity demands one.

This is the story of how we tried to fix that.

---

## CHAPTER 1: The Gift and the Gap

Then came the PDF, and it changed everything.

Suddenly any material could be read anywhere: a textbook, a research paper, a novel, a manual. The barrier of cost and distance fell away. It was a gift to every reader on earth.

But the gift left two things behind.

**The first was the space.** The room we imagined, the garden, the library, all of it was replaced by a blank white page, or a blank black one. Cold. Flat. Hard on the eyes. A place you tolerate, not a place you love.

**The second was the dictionary.** And this is where the story gets interesting.

---

## CHAPTER 2: The Word You Didn't Know

You are deep into a chapter. The argument is flowing. Then a word appears that you do not recognize.

Your brain does what brains have always done. It looks at the words around the strange one, gathers clues, and builds a guess. Most of the time this works beautifully.

But sometimes it doesn't. You read the sentence twice. Nothing. The meaning slips away.

So what do you do?

Simple. You leave the page and go to Google.

Hell no.

Here is what nobody says out loud: **Google doesn't know what you're reading.**

Consider two words: *Silicon Valley.*

You are reading about technology and startups. You highlight just the word "Silicon" and ask Google what it means. Google, with perfect confidence, tells you it is a chemical element. Atomic number 14. A semiconductor.

True. And completely useless.

Because in your book, Silicon is not an element. It is part of a place, a region in California, the beating heart of the technology world. The answer was correct and the meaning was wrong.

A single word can wear many faces. Which face it wears depends on everything around it.

**It is all about context.**

And so we asked ourselves: what if the dictionary could read over your shoulder?

---

## CHAPTER 3: The Royal Assistant

We built Arth.Find around one simple idea: **meaning belongs to context, and context lives on your page.**

Highlight a word. Or a phrase. Or an entire sentence. Arth.Find reads the text surrounding your selection and tells you what it means *here*, in *this* source, in *this* moment. No new tabs. No broken concentration. No leaving the page.

This time, when you highlight "Silicon," something different happens. A royal assistant steps forward and speaks:

> "Sir, in your source this refers to **Silicon Valley**, a region in California known as a global hub for technology."

The meaning that fits, not just the meaning that is most common.

Behind the curtain, an LLM reads the surrounding passage and reasons about what the author intended. To you, it simply feels like the page finally understands you back.

---

## CHAPTER 4: Colors That Let You Breathe

Now, the other missing piece: the space.

Your old PDF reader gave you two choices, white or black. Nobody ever chose them because they loved them.

We believe reading should be calming to the eyes. So Arth.Find offers themes whose colors were chosen with human psychology in mind, guided by what feels restful and easy on the eyes. There is no harsh glare and no cold void, only a page you can rest inside for hours.

Choose your favorite theme, and read in comfort.

---

## CHAPTER 5: Your Garden, Your Library

We cannot hand you a garden. We cannot move you into an Edinburgh library.

But what if we could bring the feeling to you?

Arth.Find gives you **wallpapers**: a collection of calming nature backgrounds you can place behind your reading. Forests. Water. Light through leaves.

And if none of them is quite right, you can **upload your own favorite backgrounds**. The photo from a trip you never forgot. The painting that calms you. The view you wish you had.

Your reader becomes personal. Your garden. Your aesthetic room. Your library. Virtually, on every page.

---

## THE PRINCIPLES

Every good idea rests on a few beliefs. These are ours:

1. **Reading should be uninterrupted.** Every tab switch is a small break in thought.
2. **Meaning is contextual.** A word alone is a guess. A word in its sentence is an answer.
3. **Space shapes focus.** A calm environment helps a reader stay with a book longer.
4. **Readers deserve ownership.** The place you read should feel like yours.

---

## WHAT YOU GET

- Context-aware meanings for words, phrases, and whole sentences
- Explanations right on the page, with no tab switching
- Calming themes chosen with human psychology in mind
- Built-in wallpapers featuring nature backgrounds
- Upload your own custom backgrounds
- A built-in PDF reader that opens local files or URLs

---

## THE PRACTICAL PART: Getting Started

Every story eventually needs a workshop. Here is where ours is.

### Opening the PDF Reader

Open the extension popup and choose **Open PDF reader**. Select a local PDF or enter a PDF URL, and it opens in the bundled PDF.js viewer. Any text rendered by the viewer can be selected to trigger an Arth.Find lookup.

### Starting the Backend

The official backend is the Python FastAPI app in `backend/app.py`.

Run it from the project root:

    uvicorn backend.app:app --reload --port 8000

The extension connects to the backend endpoint configured in `extension/crypto.js` (`BACKEND_ENDPOINT`). For local development it defaults to:

    http://127.0.0.1:8000/define

### How the Magic Works

When you highlight text, the extension sends `POST /define` with `word` and `context`. The backend accepts the word aliases used by the extension and returns a response containing `meaning`, which the extension displays as your explanation.

Provider API calls happen **only in the backend**. The extension never receives or sends Gemini, OpenAI, or NVIDIA provider keys.

### Choosing Your Engine

The backend supports **Google Gemini**, **OpenAI**, and **NVIDIA NIM**. Configure the fallback provider key and model in `backend/.env` or in your deployment environment.

### Bring Your Own Key (BYOK)

Prefer to use your own key? In BYOK mode, the extension sends your provider key once to `POST /credentials`. The backend encrypts it with `CREDENTIAL_ENCRYPTION_KEY` and returns an opaque credential reference. From then on, `/define` requests carry only that reference, and your provider key never returns to the extension after registration.

---

## EPILOGUE: The Meaning Was Always There

"Arth" (अर्थ) is the Hindi word for *meaning*.

We chose it because meaning is what every reader is really searching for. It was never hiding in a dictionary. It was hiding in the words around the word, in the page you were already reading.

We just built something that helps you find it.

For BYOK mode, the extension sends the user's provider key once to `POST /credentials`. The backend encrypts the key with `CREDENTIAL_ENCRYPTION_KEY` and returns an opaque credential reference. Subsequent `/define` requests send only that reference; provider keys never return to the extension after registration.

For persistent credentials on Render, configure PostgreSQL with `DATABASE_URL`
and keep `CREDENTIAL_ENCRYPTION_KEY` unchanged across deployments. See
[database setup and migration](backend/DATABASE.md). The root `render.yaml`
prepares the backend and its database as a Render Blueprint.
<<<<<<< HEAD
**Arth.Find: because the right meaning depends on where you find the word.**
=======
**Arth.Find: because the right meaning depends on where you find the word.**
>>>>>>> bacefb53e76fce909ef5ea3a80e78167982aad53
