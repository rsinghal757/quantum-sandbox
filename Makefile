.PHONY: install test web-install web-build run-api run-mcp clean docker-build

install:
	python3 -m pip install -e ".[dev]"

web-install:
	cd web && npm install

web-build:
	cd web && npm run build

test:
	python3 -m pytest

run-api:
	python3 -m quantum_sandbox_mcp.api

run-mcp:
	quantum-sandbox-mcp

clean:
	rm -rf .pytest_cache src/*.egg-info src/quantum_sandbox_mcp/*.pyc
	docker image prune -f >/dev/null 2>&1 || true

docker-build:
	docker build -t quantum-sandbox-mcp:local .
