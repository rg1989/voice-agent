---
name: media-playback
description: Play films, series, music and videos for the user through the Qwen Audio media tools. Use when the user asks to watch or listen to something on Netflix, Spotify, Stremio, YouTube or YouTube Music, or to pause, resume, skip, seek or stop what is playing.
---

# Media playback

The Gateway gives you two MCP tools on the `qwen_audio_media` server:

- `qwen_audio_agent_media_play` `{ url, title?, service }` plays one link.
  `service` is `youtube`, `youtube_music`, `netflix`, `spotify` or `stremio`.
  It replaces whatever is playing.
- `qwen_audio_agent_media_control` `{ action, seconds? }`, where `action` is
  `pause`, `resume`, `stop`, `next`, `previous` or `seek`. `seconds` is signed
  and only used for `seek`.

Your job: find the exact link, call the play tool once, then tell the user in
one short sentence what started. Always pass `title`, so the user hears a name
and not a link.

Do public lookups with web search and your URL reading tool (omp `read` with a
URL, Claude Code `WebFetch`), not with `curl` in bash. Many backends ask the user
before every bash command, and each question is spoken aloud.

## Account and privacy rules

- Never ask for, read, type or store a password, a verification code or payment details.
- Never read browser cookies, the Keychain or any file inside the player profile folder.
- Never open or script the user's everyday browser for playback. The play tool uses
  the dedicated player. The user signs in to it by hand once, from Settings > Media >
  Set up player.
- Never use APIs that act on the user's accounts. Use only public lookups: web search,
  TMDB, Wikidata and Cinemeta.
- If a service shows a sign-in page or a "Who's watching?" profile picker, tell the user
  to choose on screen. Do not click through it for them.
- Do not read long links or ids aloud to the user.

## Netflix

Netflix plays `https://www.netflix.com/watch/<netflixId>` with `service: "netflix"`.
The Netflix catalogue differs from country to country.

1. Find the IMDb id (`tt` followed by digits) of the title with a web search.
2. If `TMDB_API_READ_TOKEN` is set in your environment, confirm the title streams on
   Netflix in the user's country. The user sets the token in
   `~/.config/qwaudio/config.env`, and can set `TMDB_WATCH_REGION` there too: a
   two-letter ISO 3166-1 country code, for example `US`. If `TMDB_WATCH_REGION` is
   not set, ask the user which country their Netflix account is in and use its
   two-letter code. Never guess the country. This is the only lookup that needs
   bash, because TMDB wants a bearer token header, so it
   may ask the user for permission. Run it only when the token is set. First map
   the IMDb id to a TMDB id:
   ```bash
   curl -s -H "Authorization: Bearer $TMDB_API_READ_TOKEN" \
     "https://api.themoviedb.org/3/find/<imdbId>?external_source=imdb_id"
   ```
   Take `movie_results[0].id` for a film or `tv_results[0].id` for a series. Then:
   ```bash
   curl -s -H "Authorization: Bearer $TMDB_API_READ_TOKEN" \
     "https://api.themoviedb.org/3/movie/<tmdbId>/watch/providers"
   ```
   For a series, use `https://api.themoviedb.org/3/tv/<tmdbId>/watch/providers`.
   The title is on Netflix in the user's country when
   `results.<TMDB_WATCH_REGION>.flatrate` has an entry with `provider_id` 8, where
   `<TMDB_WATCH_REGION>` is the country code from above. If it has none, tell the
   user it is not on Netflix in their region and offer another service. If the token
   is not set, skip this step. If playback then fails, say that availability in
   their region could not be checked.
3. Get the Netflix id from Wikidata property P1874 (Netflix ID). Read this URL with
   your URL reading tool, with `<imdbId>` replaced:
   ```text
   https://query.wikidata.org/sparql?format=json&query=SELECT%20%3Fnetflix%20WHERE%20%7B%20%3Fitem%20wdt%3AP345%20%22<imdbId>%22%3B%20wdt%3AP1874%20%3Fnetflix.%20%7D
   ```
   It is the URL-encoded form of
   `SELECT ?netflix WHERE { ?item wdt:P345 "<imdbId>"; wdt:P1874 ?netflix. }`.
   The id is `results.bindings[0].netflix.value`.
4. If Wikidata has no P1874 value, search the web for `site:netflix.com/title <title>`.
   The number in `https://www.netflix.com/title/<id>` is the same id.
5. Call `qwen_audio_agent_media_play` with
   `url: "https://www.netflix.com/watch/<netflixId>"`, `service: "netflix"` and the title.

## Spotify

Spotify plays in the Spotify desktop app with `service: "spotify"`.

1. Search the web for `site:open.spotify.com <artist> <song, album or playlist>`.
2. Take the best `https://open.spotify.com/<type>/<id>` link. `type` is `track`, `album`,
   `playlist`, `artist`, `episode` or `show`. Ignore any `?si=` query and any `intl-xx/` part.
3. Convert it to a URI: `spotify:<type>:<id>`.
4. Call `qwen_audio_agent_media_play` with that URI, `service: "spotify"` and the title.

Never use the Spotify Web API, and never ask the user to log in to it.

## Stremio

Stremio cannot start playback from outside. The tool opens the title page and
returns `status: "opened"`. Tell the user to pick a stream there.

1. Look the title up in Cinemeta. Read this URL with your URL reading tool, and use
   `series` instead of `movie` for a series:
   ```text
   https://v3-cinemeta.strem.io/catalog/movie/top/search=<url-encoded title>.json
   ```
   Take the matching entry in `metas` and its `imdb_id` (the same `tt...` value as `id`).
2. Call `qwen_audio_agent_media_play` with
   `url: "stremio:///detail/movie/<imdbId>/<imdbId>"` (or `stremio:///detail/series/<imdbId>/<imdbId>`),
   `service: "stremio"` and the title.

## YouTube and YouTube Music

- A specific video: find its `https://www.youtube.com/watch?v=<id>` link and play it with
  `service: "youtube"`.
- A song, album or public playlist on YouTube Music: use a
  `https://music.youtube.com/watch?v=<id>` or `https://music.youtube.com/playlist?list=<id>`
  link with `service: "youtube_music"`.
- Personal mixes ("My Mix", "Supermix", liked songs) belong to the user's account and
  cannot be found from outside. Ask the user to share the link from the YouTube Music app
  (Share > Copy link), then play that link with `service: "youtube_music"`.

## Controlling playback

- "pause", "continue" (call with action "resume"), "next", "previous", "stop": call
  `qwen_audio_agent_media_control` with the matching action.
- "go back 30 seconds" is `{ "action": "seek", "seconds": -30 }`; "skip ahead a minute" is
  `{ "action": "seek", "seconds": 60 }`.
- If a tool returns `status: "failed"`, tell the user its `message` in plain words.
  Retry the same call at most once.
