import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";


const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PYTHON = process.platform === "win32" ? "python" : "python3";
const helper = join(ROOT, "scripts", "repo_paths.py");


function python(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(PYTHON, args, {
    cwd: ROOT,
    env,
    encoding: "utf8",
    timeout: 15_000,
  });
}


test("media path resolver roots relative artifacts in the repository and rejects traversal", () => {
  const inside = python([helper, "demo/final-media/containment-probe.mp4", "--label", "OUTPUT"]);
  assert.equal(inside.status, 0, inside.stderr);
  assert.equal(
    resolve(inside.stdout.trim()),
    resolve(ROOT, "demo", "final-media", "containment-probe.mp4"),
  );

  const outside = resolve(ROOT, "..", `memoryagent-containment-escape-${process.pid}.mp4`);
  assert.equal(existsSync(outside), false, "the sentinel outside path must start absent");
  const escaped = python([helper, outside, "--label", "OUTPUT"]);
  assert.notEqual(escaped.status, 0);
  assert.match(escaped.stderr, /OUTPUT must resolve inside this repository/);
  assert.equal(existsSync(outside), false, "path validation must not create an outside artifact");
});


test("caption builder rejects every outside output before creating it", () => {
  const outside = resolve(ROOT, "..", `memoryagent-caption-escape-${process.pid}`);
  assert.equal(existsSync(outside), false, "the sentinel outside directory must start absent");
  const result = python([join(ROOT, "scripts", "build_caption_filter.py")], {
    ...process.env,
    A_MAIN: "10",
    S_EFF: "12",
    CAPS_DIR: outside,
    CAPTION_WINDOWS_JSON: join(outside, "windows.json"),
    CAPTION_FILTER_FILE: join(outside, "filter.txt"),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CAPS_DIR must resolve inside this repository/);
  assert.equal(existsSync(outside), false, "a rejected override must create nothing outside the repo");
});


test("every direct media writer is wired to the shared fail-closed resolver", () => {
  const captureLive = readFileSync(join(ROOT, "scripts", "capture_live.sh"), "utf8");
  assert.match(captureLive, /repo_paths\.py[^\n]+--label TRANSCRIPT/);

  const screencast = readFileSync(join(ROOT, "scripts", "make_screencast.py"), "utf8");
  assert.match(screencast, /inside_repo\([\s\S]*?"TRANSCRIPT"/);
  assert.match(screencast, /inside_repo\([^\n]+"OUTPUT"/);
  assert.match(screencast, /REPO_ROOT[^\n]+\.artifacts[^\n]+screencast/);

  const browser = readFileSync(join(ROOT, "scripts", "capture_web.py"), "utf8");
  assert.match(browser, /inside_repo\([^\n]+"WEB_SHOTS_DIR"/);

  const captions = readFileSync(join(ROOT, "scripts", "build_caption_filter.py"), "utf8");
  for (const label of ["CAPS_DIR", "CAPTION_WINDOWS_JSON", "CAPTION_FILTER_FILE"]) {
    assert.match(captions, new RegExp(`inside_repo\\([\\s\\S]{0,180}?${label}`));
  }

  const workflow = readFileSync(join(ROOT, ".github", "workflows", "demo-video.yml"), "utf8");
  for (const repoLocal of [
    "OUTPUT: screencast.mp4",
    "vo_main.mp3",
    "vo_web.mp3",
    "voiceover.mp3",
    "web_shots",
    "demo/final-media/memoryagent-demo.mp4",
  ]) {
    assert.ok(workflow.includes(repoLocal), `demo workflow lost repo-local artifact ${repoLocal}`);
  }
});
