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

### First aid cards and other medical content

First aid cards live in `content/manual/first-aid-cards.md` and carry the tag `card`. Each one follows the same format, so it fits on half a printed page and reads the same way under stress:

1. The first paragraph starts with **"Call emergency services if you can."**
2. At most 8 numbered steps.
3. A **Do not** list, then a **Get help urgently if** list.
4. A `Source:` or `Sources:` line naming where the guidance comes from.

The test suite checks this format. Medical content must come from public domain or openly licensed sources (US government agencies such as MedlinePlus, CDC and Ready.gov, NHS content under the Open Government Licence, or the US Army field manuals), and must not invent doses or quantities. A pull request that changes medical content needs a review from someone with current first aid training.

## Code

- Shelter has no runtime dependencies and no build step. Keep it that way: no npm packages in the app, no bundlers, and no external assets loaded at runtime.
- The checks below use development tools (ESLint and the SonarQube rules) installed as `devDependencies`. Docker and the installers never install them, so nothing reaches the people running Shelter.
- Run from source with `node server.js` (Node.js 20 or newer) and check your change in the browser.
- Everything must keep working with no network connection.
- Keep pull requests small and focused, and explain why the change is needed.

### Checks

Every pull request must pass CI before it can be merged:

- **Lint**: the SonarQube "Sonar way" rules for JavaScript, the same ones SonarQube for IDE shows in VS Code (cognitive complexity, nested ternaries, regular expressions that can backtrack, and so on).
- **Tests**: `node --test` on Node 20, 22 and 24 on Linux, and Node 22 on Windows. The tests use only Node's built-in test runner.

Run the same checks locally before you push:

```
npm install        # once: development tools only
npm run check      # lint + tests
npm run lint:fix   # fix what can be fixed automatically
```

Add or update tests in `test/` for any change in behaviour. Server modules and the pure browser libraries in `public/js/lib/` are tested directly; `test/server.test.js` runs the whole server against a temporary data folder.

If a rule is wrong for one line, disable it on that line with the reason, for example `// eslint-disable-next-line sonarjs/no-os-command-from-path -- the Docker CLI is found through PATH on purpose`. SonarQube for IDE respects the same comment.

## License

By contributing you agree that your contribution is licensed under GPL-3.0-or-later, the same as the project.
