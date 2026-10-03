# Chrome Web Store listing

Paste these into the Developer Dashboard. Upload `scarecrow-1.5.0.zip` as the package.

## Name
Scarecrow

## Summary (max 132 characters)
Scare away the tweets you don't want. Describe them in plain words and Scarecrow hides them, images and videos included.

## Category
Productivity (or Social & Communication)

## Language
English

## Description
Scarecrow keeps the tweets you're tired of seeing out of your X feed.

You write filters the way you'd say them to a friend:
  Don't show me tweets about Taylor Swift, including nicknames and fan accounts.
  Don't show me tweets spoiling Severance.
  Don't show me tweets with graphic violence.

As you scroll, each tweet is checked before you read it. A match folds into a one-line note, like "Filtered: spoiling Severance, 91% match". Click the note and the tweet opens. A small counter shows how many tweets Scarecrow kept out today.

What it does
- Described filters: write what you don't want in plain words. A decision model (Jev) judges each tweet and returns a probability.
- Keyword filters: run entirely in your browser, instantly, with no key and no cost.
- Images and videos: a vision model describes pictures and a few video frames, and your filters judge that description along with the text.
- One strictness dial: only clear matches, balanced, or catch more.
- Every hidden tweet leaves a note you can open.
- If an API call fails, the tweet is shown, not hidden.

Bring your own key
Described filters and image checks use your own OpenRouter or NanoGPT API key, billed to your account by the provider. Keyword filters need no key. Scarecrow itself is free and open source (MIT).

Privacy
No Scarecrow server, no account, no analytics. Your key and filters stay in your browser. Tweet text, and images if you turn image checks on, go only to the provider you choose.

Limits
The decision model is in beta, so it will sometimes be wrong. Videos are judged on a few frames, not the audio. X changes its page markup now and then, and tweet detection can break until it is patched.

Source code: https://github.com/yashdave31/scarecrow

## Single purpose
Hide tweets on X (x.com, twitter.com) that match filters the user writes.

## Permission justifications
- storage: saves the user's filters, settings, API key and daily counts in the browser.
- Host access to x.com and twitter.com: the content script reads tweets on the page to check them against the user's filters and folds the ones that match.
- Host access to pbs.twimg.com: fetches tweet images so they can be described by the vision model when the user turns on image checks.
- Host access to openrouter.ai and nano-gpt.com: sends the tweet text, and images if enabled, to the model provider the user picks, using the user's own API key.
- Remote code: none. All code is in the package.

## Privacy practices tab
- Data collected: website content (tweet text and images) and authentication information (the user's own API key).
- Used only to provide the single purpose. Not sold, not used for unrelated purposes, not used for creditworthiness or lending.
- Privacy policy URL: https://yashdave31.github.io/scarecrow/privacy.html (after GitHub Pages is on and serving /site)

## Assets in this repo
- store/screenshots/1-feed.png (1280x800)
- store/screenshots/2-settings.png (1280x800)
- icons/icon128.png (store icon)
- Still needed: a small promo tile (440x280) is optional but recommended.
