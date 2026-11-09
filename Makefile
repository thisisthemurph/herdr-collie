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

# The collie binary arrives in Phase 1 and the controller in Phase 2.
build:
	@echo "make build: nothing to build yet (collie CLI: Phase 1, controller: Phase 2)"
