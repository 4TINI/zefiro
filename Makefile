# Zefiro – comandi rapidi (tutto gira in Docker).
export UID := $(shell id -u)
export GID := $(shell id -g)

.PHONY: data up down logs clean-cache

data:          ## scarica i dati e genera web/public/data/*.json
	mkdir -p pipeline/cache web/public/data
	docker compose --profile tools build pipeline
	docker compose --profile tools run --rm pipeline

up:            ## avvia la web app su http://localhost:8080
	docker compose up -d web

down:
	docker compose down

logs:
	docker compose logs -f web

clean-cache:   ## forza un nuovo download alla prossima `make data`
	rm -rf pipeline/cache
