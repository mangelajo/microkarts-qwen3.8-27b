PORT ?= 8080

.PHONY: install lint serve

install:
	npm install

lint: install
	npx eslint src/

serve:
	python3 -m http.server $(PORT)
