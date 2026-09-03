.PHONY: demo stop verify test integration logs

demo:
	npm run setup
	./scripts/compose.sh up --build -d
	@echo 'Fleetdeck: http://127.0.0.1:3080'

stop:
	./scripts/compose.sh down

verify:
	npm run verify

integration:
	npm run test:integration

test:
	npm test

logs:
	./scripts/compose.sh logs -f --tail=50 api worker simulator
