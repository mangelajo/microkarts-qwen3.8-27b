PORT ?= 8080

.PHONY: install lint imports serve sim simwatch netsim wscheck wse2e screens qrcheck deploy

# production deploy target (ajo.es/microkarts) — override to deploy elsewhere
DEPLOY_HOST ?= ajo@cpanel.optimizacionweb.es
DEPLOY_DIR  ?= /home/ajo/public_html/ajo.es/microkarts

install:
	npm install

lint: install
	npx eslint src/ ai-sim/ server/

# static import-graph check: every relative import must name an export the
# target declares — catches browser-only modules (main.js, hud.js, …) that
# the headless sims never import
imports: install
	node ai-sim/imports.mjs

serve:
	python3 ai-sim/serve.py $(PORT)

sim: install
	node --import ./ai-sim/stub.js ai-sim/sim.mjs

# watch mode: re-run the AI bench on every change in src/ + ai-sim/
simwatch: install
	node ai-sim/watch.mjs

netsim: install
	node --import ./ai-sim/stub.js ai-sim/net-sim.mjs

# ws server gate: spawns the real Node server in-process and drives it with a
# WS client (health, lobby, create/join, handshake, start, state 30 Hz,
# input → server-authoritative control, PING/PONG, forced finish, BYE,
# host-left dissolve, room-full kick)
wscheck:
	WS_TEST=1 node ai-sim/ws-check.mjs

# ws E2E: two real browser pages race over the local Node server (needs
# `make serve` + the server; SKIPs otherwise)
wse2e:
	WS_E2E_PORT=8317 node ai-sim/ws-e2e.mjs

# Playwright render check: boots the game in headless Chromium (menu / 2P /
# countdown / race, desktop + phone viewports), captures into screens/ and
# fails on any page JS error. One-time setup: npx playwright install chromium
screens: install
	npm run screens

# QR encoder gate: structural checks (finders/timing/alignment/format/version) +
# full zigzag read-back (un-mask, de-interleave, RS syndrome via independently
# computed generator) on 7 version cases × all 8 masks + exact-matrix fixture
qrcheck: install
	node ai-sim/qr-check.mjs

# upload the game to the live server; run the gates first (`make sim netsim deploy`)
deploy:
	scp index.html $(DEPLOY_HOST):$(DEPLOY_DIR)/
	scp src/* $(DEPLOY_HOST):$(DEPLOY_DIR)/src/
	scp -r api $(DEPLOY_HOST):$(DEPLOY_DIR)/
