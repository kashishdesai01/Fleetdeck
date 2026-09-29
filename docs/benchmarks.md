# Benchmark harness

The benchmark generates telemetry for 25 synthetic vehicles and measures admission and worker processing against PostgreSQL. Each run creates an isolated schema and removes it when finished.

```sh
FLEETDECK_TEST_URL=postgres://fleetdeck:password@127.0.0.1:5432/fleetdeck_test npm run benchmark
```

The workload contains ten batches of 100 messages, processed by one worker. Requests use Fastify's in-process HTTP interface. Output includes:

- CPU, memory, Node.js, and PostgreSQL versions.
- Raw admission and processing durations for each batch.
- Median and 95th-percentile batch durations.
- Combined message rate and remaining backlog.

The command prints its report and writes `test-results/benchmark.json`. Use the same workload and environment when comparing changes to ingestion or worker processing.
