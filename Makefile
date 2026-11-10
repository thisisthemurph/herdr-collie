# Herdr Collie. `make check` must be green before every PR.
.PHONY: check lint typecheck test fixtures fixtures-check build format install mod mod-install bin-install

BUN ?= bun

check: lint typecheck test

install-deps:
	$(BUN) install --frozen-lockfile

lint:
	$(BUN) run lint

typecheck:
	$(BUN) run typecheck

test:
	$(BUN) test ./packages ./tools ./mod

# Regenerate fixtures/ from fixtures/src/build.ts after a schema change.
fixtures:
	$(BUN) fixtures/src/build.ts

fixtures-check:
	$(BUN) fixtures/src/build.ts --check

format:
	$(BUN) run format

# dist/collie (the CLI) and dist/collie-controller, each one self-contained binary.
build:
	$(BUN) build --compile packages/cli/src/main.ts --outfile dist/collie
	$(BUN) build --compile packages/controller/src/main.ts --outfile dist/collie-controller

# The Herdr mod: one bundled main.js (gpui-kit, gpui-base, herdr and fs/promises stay imports).
MOD_DIR ?= $(HOME)/.config/herdr-app/mods/collie
mod:
	$(BUN) build mod/src/main.ts --outfile mod/dist/main.js --format esm --target node \
	  --external gpui-kit --external gpui-base --external herdr --external fs/promises

# Installs the mod into Herdr and checks it (needs Herdr). Open it with:
#   herdr-app do tab.new --name Collie --mod collie
mod-install: mod
	mkdir -p $(MOD_DIR)
	cp mod/dist/main.js mod/mod.json $(MOD_DIR)/
	herdr-app check $(MOD_DIR)

# Puts collie and collie-controller on PATH, where the mod runs them from.
BIN_DIR ?= $(HOME)/.local/bin
bin-install: build
	mkdir -p $(BIN_DIR)
	cp dist/collie dist/collie-controller $(BIN_DIR)/

install: bin-install mod-install
