# Build and run the app. Make compares file times, so each step only runs when
# its inputs changed since the last run:
#   make build     install packages if the lock file changed, rebuild the web UI if its sources changed
#   make start     build, then start the Gateway unless it is already running
#   make restart   build, then restart the Gateway (server code needs no build, only a restart)
URL := http://127.0.0.1:3101

LOCKS := package-lock.json package.json $(wildcard */package.json)
WEB_SOURCES := $(shell find web/src web/index.html web/vite.config.js web/package.json shared -type f 2>/dev/null)

.PHONY: build start restart

build: web/dist/index.html
	@echo "Built. Open $(URL)"

# npm ci also builds the web UI (the prepare script).
node_modules/.package-lock.json: $(LOCKS)
	npm ci --no-audit --no-fund
	@touch $@

web/dist/index.html: node_modules/.package-lock.json $(WEB_SOURCES)
	npm run build
	@touch $@

start: web/dist/index.html
	@if curl -s -m 2 $(URL)/api/health | grep -q '"ok"'; then echo "  Already running."; else bin/restart; fi
	@echo "Open $(URL)"

restart: web/dist/index.html
	@bin/restart
	@echo "Open $(URL)"
