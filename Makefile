# Herdr Collie. `make check` must be green before every PR.
.PHONY: check lint typecheck test fixtures fixtures-check build format install

BUN ?= bun

check: lint typecheck test

install:
	$(BUN) install --frozen-lockfile

lint:
	$(BUN) run lint

typecheck:
	$(BUN) run typecheck

test:
	$(BUN) test ./packages ./tools

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
