# Offline test harness

`express/` is a minimal Express stand-in — routing with `:params`, the json and
raw body parsers, and static file serving. It exists so the test suite and the
server can run **before** `npm install`, or with no network at all.

To use it:

    mkdir -p node_modules && cp -r test-harness/express node_modules/

Once `npm install` has fetched the real Express, delete `node_modules/express`
and reinstall — the real package is what production uses. This directory is
gitignored and is not part of the application.
