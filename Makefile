PORT ?= 8080

.PHONY: install lint serve sim

install:
	npm install

lint: install
	npx eslint src/

serve:
	python3 -m http.server $(PORT)

sim: install
	node --import ./ai-sim/stub.js ai-sim/sim.mjs
