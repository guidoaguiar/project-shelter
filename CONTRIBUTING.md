# Contributing to Shelter

Thanks for helping. Shelter is meant to be useful when nothing else is available, so accuracy and simplicity matter more than features.

## Ways to help

- **Manual content.** Add entries, fix mistakes, improve figures. This is the most valuable contribution. See [Adding to the manual](README.md#adding-to-the-manual) for the file format.
- **Depot services.** Propose an offline service for `config/depot.json`. Use the format in [Adding your own services](README.md#adding-your-own-services), and say where the service's content comes from and how big it is.
- **Bugs.** Open an issue with your OS, how you installed (installer, Docker, or from source), what you expected and what happened. Output from `shelter logs` or `docker compose logs` helps.
- **Testing on real hardware.** Reports from a Raspberry Pi, an old laptop or a mini PC are welcome, even when everything works.

## Ground rules for manual content

- Cite your source in the pull request. Public domain sources, such as US government field manuals, are preferred.
- Only submit content you have the right to share under GPL-3.0-or-later.
- Medical and water safety content needs a source and a reviewer before it is merged.
- Keep entries practical: steps, quantities and warnings over background.

## Code

- Shelter has no dependencies and no build step. Keep it that way: no npm packages, no bundlers, and no external assets loaded at runtime.
- Run from source with `node server.js` (Node.js 20 or newer) and check your change in the browser.
- Everything must keep working with no network connection.
- Keep pull requests small and focused, and explain why the change is needed.

## License

By contributing you agree that your contribution is licensed under GPL-3.0-or-later, the same as the project.
