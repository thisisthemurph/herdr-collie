# mod: the Collie Herdr mod

The Collie tab: Board setup and the dependency graph. Written in TypeScript against Herdr's
own `docs/herdr/*.d.ts` (`mod/tsconfig.json`), bundled by `make mod` into one `main.js`.

```sh
make install                                        # collie + collie-controller into ~/.local/bin, the mod into Herdr
herdr-app do tab.new --name Collie --mod collie     # open the Collie tab in the focused space
```

- `src/model.ts`: the view model, pure and unit-tested (`mod/test/`).
- `src/collie.ts`: reads `~/.collie`, runs `collie ctl`, and starts the controller with
  `hc run` (label `collie.role=controller`) when no live one holds `controller.lock`.
- `src/main.ts`: rendering. It holds no state beyond what's on screen; a folder watch on
  `~/.collie` redraws it, so reloading the mod loses nothing.

The mod needs `collie` and `collie-controller` on your PATH, and the `collie-jira` keychain
item (account: your Atlassian email; password: an API token with read access to Jira).
