"""Offline training only. Serving consumes validated JSON trees, never pickle files."""
import argparse
import hashlib
import json
import math
import platform
from pathlib import Path

import numpy as np
import sklearn
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.linear_model import Ridge
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

NAMES = ["distance", "turns", "battery", "congestion"]
parser = argparse.ArgumentParser()
parser.add_argument("--data", default=".local/eta/dataset.jsonl")
parser.add_argument("--output", default="packages/eta/artifacts")
args = parser.parse_args()
data = Path(args.data).read_bytes()
rows = [json.loads(line) for line in data.splitlines()]
by_split = {name: [r for r in rows if r["split"] == name]
            for name in ["train", "validation", "calibration", "test", "stress"]}
assert all(by_split.values()), "Missing evaluation partition"
groups = {name: {r["runId"] for r in values} for name, values in by_split.items()}
assert all(not groups[a] & groups[b] for a in groups for b in groups if a != b)


def matrix(items):
    return np.asarray([[r["features"][key] for key in NAMES] for r in items])


def labels(items):
    return np.asarray([r["seconds"] for r in items])


train = by_split["train"]
x, y = matrix(train), labels(train)
params = dict(n_estimators=140, max_depth=3, min_samples_leaf=15,
              learning_rate=0.06, loss="squared_error", random_state=731)
model = GradientBoostingRegressor(**params).fit(x, y)
linear = make_pipeline(StandardScaler(), Ridge(alpha=1.0)).fit(x, y)
# A learned average speed is a stronger distance-only baseline than an arbitrary constant.
distance_coefficient = float(np.dot(x[:, 0], y) / np.dot(x[:, 0], x[:, 0]))


def prediction(items):
    return np.maximum(1, model.predict(matrix(items)))


validation = by_split["validation"]
v_y, v_x = labels(validation), matrix(validation)
validation_mae = float(np.mean(np.abs(prediction(validation) - v_y)))
comparison_maes = {
    "constant_speed": float(np.mean(np.abs(v_x[:, 0] / 24 - v_y))),
    "learned_speed": float(np.mean(np.abs(v_x[:, 0] * distance_coefficient - v_y))),
    "linear": float(np.mean(np.abs(np.maximum(1, linear.predict(v_x)) - v_y))),
}
# Fixed promotion policy, evaluated before touching calibration or test labels.
promoted = validation_mae <= 0.95 * min(comparison_maes.values())

# Calibrate on per-run maximum residuals. All six correlated missions stay together.
calibration = by_split["calibration"]
run_errors = {}
for row, error in zip(calibration, np.abs(prediction(calibration) - labels(calibration))):
    run_errors[row["runId"]] = max(run_errors.get(row["runId"], 0), float(error))
alpha = 0.10
rank = min(len(run_errors), math.ceil((len(run_errors) + 1) * (1 - alpha)))
radius = sorted(run_errors.values())[rank - 1]


def evaluate(items):
    xx, yy, pp = matrix(items), labels(items), prediction(items)
    errors = np.abs(pp - yy)
    baseline_errors = np.abs(np.maximum(1, xx[:, 0] / 24) - yy)
    covered = errors <= radius
    run_coverage = {}
    for row, ok in zip(items, covered):
        run_coverage[row["runId"]] = run_coverage.get(row["runId"], True) and bool(ok)
    # Paired bootstrap resamples entire runs; individual missions are not independent.
    run_deltas = [float(np.mean([errors[i] - baseline_errors[i]
                               for i, row in enumerate(items) if row["runId"] == run]))
                  for run in sorted(run_coverage)]
    rng = np.random.default_rng(731)
    boot = np.mean(rng.choice(run_deltas, (1000, len(run_deltas)), replace=True), axis=1)
    return dict(missions=len(items), runs=len(run_coverage),
                model_mae_seconds=float(np.mean(errors)), model_p95_error_seconds=float(np.quantile(errors, .95)),
                constant_speed_mae_seconds=float(np.mean(baseline_errors)),
                learned_speed_mae_seconds=float(np.mean(np.abs(xx[:, 0] * distance_coefficient - yy))),
                linear_mae_seconds=float(np.mean(np.abs(np.maximum(1, linear.predict(xx)) - yy))),
                paired_mae_delta_95pct_ci_seconds=[float(n) for n in np.quantile(boot, [.025, .975])],
                mission_interval_coverage=float(np.mean(covered)),
                simultaneous_run_interval_coverage=float(np.mean(list(run_coverage.values()))),
                mean_interval_width_seconds=float(np.mean(pp + radius - np.maximum(0, pp - radius))))


trees = []
for estimator in model.estimators_[:, 0]:
    tree = estimator.tree_
    trees.append(dict(left=tree.children_left.tolist(), right=tree.children_right.tolist(),
                      feature=tree.feature.tolist(), threshold=tree.threshold.tolist(),
                      value=tree.value[:, 0, 0].tolist()))
evaluation = {"test": evaluate(by_split["test"])}
example_predictions = prediction(by_split["test"])
examples = []
for row, pp in zip(by_split["test"], example_predictions):
    bb = max(1, row["features"]["distance"] / 24)
    examples.append(dict(runId=row["runId"], mission=row["mission"], features=row["features"],
                         observed_seconds=row["seconds"], model_seconds=float(pp), baseline_seconds=bb,
                         model_absolute_error_seconds=abs(float(pp) - row["seconds"]),
                         baseline_absolute_error_seconds=abs(bb - row["seconds"])))
examples.sort(key=lambda r: r["model_absolute_error_seconds"] - r["baseline_absolute_error_seconds"], reverse=True)
for scenario in ["severe_congestion", "hidden_delays"]:
    evaluation[scenario] = evaluate([r for r in by_split["stress"] if r["scenario"] == scenario])
model_body = dict(schemaVersion=1, featureVersion="dispatch-v1", featureNames=NAMES,
                  initial=float(model.init_.constant_[0, 0]), learningRate=params["learning_rate"],
                  trees=trees, radiusSeconds=radius, nominalRunCoverage=.90,
                  # Physical contract limits, deliberately wider than sampled extrema.
                  support=[[0, 1200], [0, 2], [25, 100], [0, .8]],
                  promoted=promoted, trainingDataSha256=hashlib.sha256(data).hexdigest())
encoded = json.dumps(model_body, separators=(",", ":"), allow_nan=False).encode()
version = "eta-gbr-v1-" + hashlib.sha256(encoded).hexdigest()[:12]
artifact = dict(version=version, **model_body)
output = Path(args.output)
output.mkdir(parents=True, exist_ok=True)
model_bytes = (json.dumps(artifact, separators=(",", ":"), allow_nan=False) + "\n").encode()
(output / "model.json").write_bytes(model_bytes)
report = dict(version=version, boundary="Synthetic dispatch-to-observed-completion only; no real fleet accuracy claim.",
              trainerSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              requirementsSha256=hashlib.sha256(Path('ml/requirements.txt').read_bytes()).hexdigest(),
              model="scikit-learn GradientBoostingRegressor", params=params,
              python=platform.python_version(), sklearn=sklearn.__version__, numpy=np.__version__,
              modelSha256=hashlib.sha256(model_bytes).hexdigest(),
              dataset=json.loads(Path(args.data).with_name("dataset-manifest.json").read_text()),
              splits={k: dict(missions=len(v), runs=len(groups[k])) for k, v in by_split.items()},
              validation=dict(model_mae_seconds=validation_mae, baselines=comparison_maes,
                              promotionPolicy="At least 5% lower validation MAE than all three baselines.", promoted=promoted),
              calibration=dict(method="Split conformal, per-run maximum absolute residual", runs=len(run_errors),
                               radius_seconds=radius, nominal_simultaneous_run_coverage=.90,
                               assumption="Independent exchangeable synthetic runs; no coverage guarantee under distribution shift."),
              evaluation=evaluation,
              heldOutExamples=dict(largest_model_losses=examples[:5], largest_model_improvements=examples[-5:]),
              servingPolicy="Baseline for disabled/unavailable/unpromoted model or out-of-support features; no calibrated interval on fallback.",
              exclusions=["No training on live demo missions", "No future speed, pauses, execution seed or final battery in features",
                          "Severe congestion and hidden delays excluded from training, validation and calibration",
                          "Stress metrics show raw model behavior; severe congestion is rejected by serving support guard"])
(output / "evaluation.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
parity = [dict(features=r["features"], expected=float(p))
          for r, p in zip(by_split["test"][:40], prediction(by_split["test"][:40]))]
(output / "parity.json").write_text(json.dumps(parity, indent=2) + "\n")
print(json.dumps(dict(version=version, promoted=promoted, validation=report["validation"], evaluation=evaluation), indent=2))
if not promoted:
    raise SystemExit("Model failed the predeclared validation gate; artifact will serve baseline only.")
