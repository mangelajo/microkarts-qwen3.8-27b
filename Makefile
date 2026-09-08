PORT ?= 8080

.PHONY: install lint imports serve sim netsim

install:
	npm install

lint: install
	npx eslint src/ ai-sim/

# static import-graph check: every relative import must name an export the
# target declares — catches browser-only modules (main.js, hud.js, …) that
# the headless sims never import
imports: install
	node ai-sim/imports.mjs

serve:
	python3 ai-sim/serve.py $(PORT)

sim: install
	node --import ./ai-sim/stub.js ai-sim/sim.mjs

netsim: install
	node --import ./ai-sim/stub.js ai-sim/net-sim.mjs
