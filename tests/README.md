# `tests/`

Reserved for an automated test suite. Empty for now — this project has no
committed automated tests yet (`backend/`'s routes/services were verified
manually against the live PostgreSQL database and in-browser throughout
development, but that verification was never turned into a repeatable
`pytest` suite). Adding real backend tests here (e.g. `pytest` +
`httpx.AsyncClient` against a test database) is a genuine follow-up piece
of work, not something this folder-reorganization pass fabricates.
