PORT ?= 8080

.PHONY: install lint serve sim netsim

install:
	npm install

lint: install
	npx eslint src/ ai-sim/

serve:
	python3 ai-sim/serve.py $(PORT)

sim: install
	node --import ./ai-sim/stub.js ai-sim/sim.mjs

netsim: install
	node --import ./ai-sim/stub.js ai-sim/net-sim.mjs
