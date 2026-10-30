StatusMenu.json here is a PLACEHOLDER, not a menu. It renders a notice saying so,
which is enough for the dev loop to apply this pack without error and for you to watch
the pipeline work end to end - and nothing more.

The REAL menu body comes from MVU Status Menu Builder: design the layout there, export
the StatusMenu Pack, and drop its regex/StatusMenu.json over this file. It carries the
same script_name, so it REPLACES this one rather than sitting beside it - two enabled
regexes matching the placeholder means first-in-list wins silently. Never hand-edit a
real one: it is generated, and the builder is where changes belong.
