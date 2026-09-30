# Mission ETA

Fleetdeck predicts dispatch-to-observed-completion duration for its simulated fleet. The console displays the estimate before dispatch and stores the prediction with the mission, including model version, feature values, prediction time, and artifact checksum.

## Model

Training uses scikit-learn's `GradientBoostingRegressor` with 140 depth-three trees, learning rate 0.06, minimum 15 samples per leaf, squared-error loss, and random seed 731. The runtime evaluates exported JSON trees in TypeScript. Inputs use float32 comparisons to match scikit-learn tree traversal.

| Feature    | Definition                                                          |
| ---------- | ------------------------------------------------------------------- |
| Distance   | Central-aisle route length in map units                             |
| Turns      | Direction changes along the route                                   |
| Battery    | Fresh battery percentage at dispatch                                |
| Congestion | Active or uncertain site reservations divided by site vehicle count |

The workload snapshot is included in the command sent to the simulator. Future motion state, execution seeds, realized speeds, and completion timestamps are excluded from features.

## Dataset and evaluation

The live simulator and dataset generator share `packages/simulation/src/motion.ts`. Motion includes variable cruise speed, battery-dependent slowing, congestion-dependent pauses, startup delay, turn dwell, and battery consumption. The generator labels travel and pause duration plus gateway/report scheduling jitter. Seeds and random state make motion resumable and dataset generation repeatable.

Each run contains six missions and belongs to exactly one partition:

| Partition                   | Runs | Missions |
| --------------------------- | ---: | -------: |
| Training                    |  600 |    3,600 |
| Validation                  |  100 |      600 |
| Calibration                 |  150 |      900 |
| Test                        |  200 |    1,200 |
| Severe-congestion scenarios |   80 |      480 |
| Additional-delay scenarios  |   80 |      480 |

The validation gate requires at least 5% lower mean absolute error than three baselines: distance divided by nominal speed, a training-fitted average-speed coefficient, and standardized ridge regression over all four features. Model parameters are fixed before held-out evaluation.

| Predictor                | Held-out synthetic MAE |
| ------------------------ | ---------------------: |
| Distance / nominal speed |                20.31 s |
| Learned average speed    |                 9.12 s |
| Linear regression        |                 5.78 s |
| Gradient-boosted trees   |                 4.65 s |

The 95th-percentile model absolute error is 14.58 s. Evaluation includes per-scenario metrics, individual prediction examples, and a paired bootstrap that resamples entire runs.

Split-conformal calibration uses the maximum absolute residual per run and targets simultaneous coverage of all six missions in 90% of exchangeable synthetic runs. Test run coverage is 91.5%; mission coverage is 97.33%. The mean displayed interval width is 34.30 s. Stress-scenario results are recorded separately.

Release data, model settings, source hashes, calibration values, and full results are in [`evaluation.json`](../packages/eta/artifacts/evaluation.json). [`parity.json`](../packages/eta/artifacts/parity.json) contains Python reference predictions used by the TypeScript tests.

## Training

The application includes a trained artifact. For offline training, use Python 3.13 and the pinned dependencies:

```sh
python3.13 -m venv .local/ml-venv
.local/ml-venv/bin/python -m pip install -r ml/requirements.txt
npm run eta:train
npm run eta:reproduce
```

`ETA_PYTHON=/path/to/python` selects another interpreter. Dataset generation writes to `.local/eta`; training writes release artifacts to `packages/eta/artifacts`. Reproduction checks tree structure, source and dataset hashes, parity predictions, decisions, and evaluation against the release. Numeric values use a tolerance of 1e-8 absolute plus 1e-10 relative; each artifact's checksum is checked against its own manifest. All missions from a run stay in one partition throughout fitting, calibration, and evaluation.

## Serving

`GET /v1/eta?vehicleId=<uuid>&destination=shipping` returns an authenticated preview. Dispatch recomputes against current state and saves the prediction atomically with the reservation and command. An idempotent retry returns the original response and prediction.

The loader checks feature order, schema, tree topology, indices, numeric values, artifact size and checksum. Serving selects an explicitly labeled distance/speed baseline when the model is disabled, unavailable, outside input support, or produces an invalid result. Baseline responses carry a duration and source reason. Fresh telemetry is required for an estimate. Set `ETA_ENABLED=false` to select baseline mode.

Predictions represent the original dispatch estimate. Mission cards suspend ETA display during reconciliation or cancellation, and mark an active mission when its original upper range has elapsed. Workflow transitions continue to use vehicle reports and reservation rules.

## Monitoring

Administrators can read `/v1/eta/monitoring` and Prometheus `fleetdeck_eta_recent_*` metrics. The latest 500 stored predictions are grouped by source and model version, with prediction counts, completion labels, reconciled exclusions, mean absolute error, baseline error, and interval coverage. Preview requests and idempotent retries do not add stored predictions.

Completion duration uses the terminal report's first server receipt time. Reconciled or delayed reports are counted separately from normal completion-error metrics. Inspect active missions alongside completion statistics, and use `ETA_ENABLED=false` to switch to baseline mode while investigating model behavior.

## References

- [scikit-learn gradient boosting](https://scikit-learn.org/1.7/modules/generated/sklearn.ensemble.GradientBoostingRegressor.html)
- [Data partitioning and preprocessing](https://scikit-learn.org/stable/common_pitfalls.html#data-leakage)
