`20260927_init_assistant.sql` documents a schema that was never what went live
(an `embedding` column on `properties`, plus public `anon`/`authenticated`
grants on `chat_messages`). It is kept here for history only.

Do not run it. `20261002_align_with_live_schema.sql` reflects the actual
live schema and should be applied instead on a fresh environment.
