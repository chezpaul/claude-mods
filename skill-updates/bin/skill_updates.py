#!/usr/bin/env python3
"""Check installed skills and plugins against their GitHub sources, and update them.

  skill_updates.py check            -> JSON report on stdout
  skill_updates.py update <id>      -> JSON result on stdout

Kinds of item:
  personal  ~/.claude/skills/<name>, replaced in place (old copy kept in ~/.claude/skill-backups)
  claudeai  a skill you uploaded to claude.ai; the update is a zip on the Desktop to re-upload
  plugin    a marketplace plugin; updated with `claude plugin update`

GitHub repos come from sources.json beside this folder, else from github.com links in the skill's files.
"""
import base64
import concurrent.futures
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time

HOME = os.path.expanduser("~")
SKILLS = os.path.join(HOME, ".claude", "skills")
SYNCED = os.path.join(SKILLS, "synced")
BACKUPS = os.path.join(HOME, ".claude", "skill-backups")
MARKETPLACES = os.path.join(HOME, ".claude", "plugins", "known_marketplaces.json")
DESKTOP = os.path.join(HOME, "Desktop")
MOD_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCES = os.path.join(MOD_ROOT, "sources.json")

GH_URL = re.compile(r"github\.com[/:]([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?(?=[/)\s\"'#?]|$)", re.M)
VERSION = re.compile(r"^\s*version:\s*[\"']?([^\"'\n]+?)[\"']?\s*$", re.M)
HEX = re.compile(r"^[0-9a-f]{7,40}$")
NOT_REPOS = {"github.com/anthropics/skills"}


# ---------- helpers ----------

def gh(path, raw=False):
    out = subprocess.run(["gh", "api", path], capture_output=True, timeout=60)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.decode(errors="replace").strip().splitlines()[-1] if out.stderr else f"gh api {path} failed")
    return out.stdout if raw else json.loads(out.stdout)


def gh_file(repo, path, ref):
    data = gh(f"repos/{repo}/contents/{path}?ref={ref}")
    return base64.b64decode(data["content"]).decode("utf-8", errors="replace")


def blob_sha(path):
    with open(path, "rb") as f:
        data = f.read()
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def version_of(text):
    m = VERSION.search(text.split("\n---", 1)[0] if text.startswith("---") else text[:2000])
    return m.group(1).strip() if m else None


def load_sources():
    try:
        with open(SOURCES) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


_trees = {}


def repo_tree(repo):
    """(commit sha, {path: blob sha}) of the default branch, cached per run."""
    if repo not in _trees:
        sha = gh(f"repos/{repo}/commits/HEAD")["sha"]
        tree = gh(f"repos/{repo}/git/trees/{sha}?recursive=1")
        _trees[repo] = (sha, {t["path"]: t["sha"] for t in tree["tree"] if t["type"] == "blob"})
    return _trees[repo]


# ---------- skills ----------

def discover_skills():
    items = []
    for name in sorted(os.listdir(SKILLS)):
        d = os.path.join(SKILLS, name)
        if name.startswith(".") or name == "synced" or not os.path.isfile(os.path.join(d, "SKILL.md")):
            continue
        items.append({"kind": "personal", "name": name, "dir": d})
    for bucket in sorted(os.listdir(SYNCED)) if os.path.isdir(SYNCED) else []:
        b = os.path.join(SYNCED, bucket)
        try:
            with open(os.path.join(b, "manifest.json")) as f:
                manifest = json.load(f)
        except (OSError, ValueError):
            continue
        for s in manifest.get("skills", []):
            d = os.path.join(b, s["name"])
            # Anthropic's own skills update themselves; only your uploads are checked.
            if s.get("source") == "plugin" and os.path.isfile(os.path.join(d, "SKILL.md")):
                items.append({"kind": "claudeai", "name": s["name"], "dir": d})
    return items


def guess_repos(skill_dir):
    counts = {}
    for root, dirs, files in os.walk(skill_dir):
        dirs[:] = [x for x in dirs if not x.startswith(".")]
        if root.count(os.sep) - skill_dir.count(os.sep) > 1:
            continue
        for fn in files:
            if not fn.endswith(".md"):
                continue
            try:
                text = open(os.path.join(root, fn), encoding="utf-8", errors="replace").read()
            except OSError:
                continue
            for m in GH_URL.finditer(text):
                repo = f"{m.group(1)}/{m.group(2)}"
                if f"github.com/{repo}" in NOT_REPOS or m.group(1) in ("orgs", "features", "settings"):
                    continue
                bonus = 5 if "git clone" in text[max(0, m.start() - 40):m.start()] else 1
                counts[repo] = counts.get(repo, 0) + bonus
    return sorted(counts, key=lambda r: -counts[r])


def skill_path_in(files, name):
    """Folder in the repo that holds this skill's SKILL.md ('' for the root)."""
    candidates = [p[: -len("SKILL.md")].rstrip("/") for p in files if p == "SKILL.md" or p.endswith("/SKILL.md")]
    named = [c for c in candidates if os.path.basename(c) == name]
    if named:
        return min(named, key=len)
    if "" in candidates:
        return ""
    return None


def compared_files(files, path, skill_md_text, local_dir):
    """Upstream files (relative to the skill folder) that a local copy should match."""
    prefix = path + "/" if path else ""
    rel = {p[len(prefix):]: s for p, s in files.items() if p.startswith(prefix)}
    rel = {p: s for p, s in rel.items() if not any(seg.startswith(".") for seg in p.split("/"))}
    if path:
        keep = rel
    else:
        # A skill at a repo's root shares it with the repo's own files: keep SKILL.md
        # and the folders SKILL.md mentions.
        dirs = {p.split("/")[0] for p in rel if "/" in p}
        mentioned = {d for d in dirs if re.search(r"(?<![\w-])" + re.escape(d) + r"/", skill_md_text)}
        keep = {p: s for p, s in rel.items() if p == "SKILL.md" or p.split("/")[0] in mentioned}
        for extra in ("LICENSE", "LICENSE.md", "README.md"):
            if extra in rel:
                keep[extra] = rel[extra]
    if local_dir is None:
        return keep
    # README and LICENSE count only where the local copy has them.
    return {p: s for p, s in keep.items()
            if not (os.path.basename(p) in ("README.md", "LICENSE", "LICENSE.md")
                    and not os.path.exists(os.path.join(local_dir, p)))}


def check_skill(item, sources):
    name, d = item["name"], item["dir"]
    local_md = open(os.path.join(d, "SKILL.md"), encoding="utf-8", errors="replace").read()
    out = {"id": f"{item['kind']}:{name}", "kind": item["kind"], "name": name, "localVersion": version_of(local_md)}
    override = sources.get("skills", {}).get(name)
    if override == "none" or name in sources.get("ignore", []):
        return {**out, "status": "untracked", "note": "no GitHub source"}
    repos = [override] if override else guess_repos(d)
    for repo in repos[:3]:
        try:
            sha, files = repo_tree(repo)
        except RuntimeError as err:
            if override:
                return {**out, "repo": repo, "status": "error", "note": str(err)[:200]}
            continue
        path = skill_path_in(files, name)
        if path is None:
            continue
        upstream_md = gh_file(repo, (path + "/" if path else "") + "SKILL.md", sha)
        want = compared_files(files, path, upstream_md, d)
        changed = [p for p, s in want.items()
                   if not os.path.isfile(os.path.join(d, p)) or blob_sha(os.path.join(d, p)) != s]
        return {**out, "repo": repo, "path": path, "remoteSha": sha, "remoteVersion": version_of(upstream_md),
                "status": "outdated" if changed else "current", "changed": changed[:20]}
    return {**out, "status": "untracked", "note": "no GitHub source"}


def fetch_skill(repo, sha, path, dest):
    """Writes the upstream copy of the skill into dest; returns the files written."""
    _, files = repo_tree(repo)
    upstream_md = gh_file(repo, (path + "/" if path else "") + "SKILL.md", sha)
    want = compared_files(files, path, upstream_md, None)
    data = gh(f"repos/{repo}/tarball/{sha}", raw=True)
    written = []
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        for m in tar.getmembers():
            parts = m.name.split("/", 1)
            if len(parts) < 2 or not m.isfile():
                continue
            inner = parts[1]
            prefix = path + "/" if path else ""
            if not inner.startswith(prefix) or inner[len(prefix):] not in want:
                continue
            rel = inner[len(prefix):]
            target = os.path.realpath(os.path.join(dest, rel))
            if not target.startswith(os.path.realpath(dest) + os.sep):
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with tar.extractfile(m) as src, open(target, "wb") as f:
                f.write(src.read())
            if m.mode & 0o111:
                os.chmod(target, 0o755)
            written.append(rel)
    if "SKILL.md" not in written:
        raise RuntimeError("the download held no SKILL.md")
    return written


# ---------- plugins ----------

def parse_source(src, market_repo):
    if isinstance(src, str):
        return market_repo, src.strip("./").strip("/") if src not in ("./", ".") else ""
    if isinstance(src, dict):
        kind = src.get("source")
        if kind == "github" and src.get("repo"):
            return src["repo"], src.get("path", "").strip("/")
        url = src.get("url") or src.get("repo") or ""
        m = GH_URL.search(url)
        if m:
            return f"{m.group(1)}/{m.group(2)}", src.get("path", "").strip("/")
    return None, None


def check_plugin(p, markets):
    pid, iv = p["id"], str(p.get("version", ""))
    name, _, mk = pid.partition("@")
    out = {"id": f"plugin:{pid}", "kind": "plugin", "name": name, "marketplace": mk, "localVersion": iv,
           "enabled": p.get("enabled", False)}
    msrc = markets.get(mk, {}).get("source", {})
    market_repo = msrc.get("repo") if msrc.get("source") == "github" else None
    if not market_repo:
        return {**out, "status": "untracked", "note": "marketplace not on GitHub"}
    catalog = json.loads(gh_file(market_repo, ".claude-plugin/marketplace.json", "HEAD"))
    entry = next((e for e in catalog.get("plugins", []) if e.get("name") == name), None)
    if not entry:
        return {**out, "status": "error", "note": "no longer listed in its marketplace"}
    repo, path = parse_source(entry.get("source"), market_repo)
    if not repo:
        return {**out, "status": "untracked", "note": "source not on GitHub"}
    out["repo"] = repo
    if HEX.match(iv):
        cmp = gh(f"repos/{repo}/compare/{iv}...HEAD")
        head = cmp["commits"][-1]["sha"] if cmp.get("commits") else None
        touched = [f["filename"] for f in cmp.get("files", []) if not path or f["filename"].startswith(path + "/")]
        outdated = cmp.get("ahead_by", 0) > 0 and bool(touched)
        return {**out, "remoteVersion": head[:12] if head else iv, "status": "outdated" if outdated else "current"}
    rv = entry.get("version")
    if not rv:
        try:
            rv = json.loads(gh_file(repo, (path + "/" if path else "") + ".claude-plugin/plugin.json", "HEAD")).get("version")
        except (RuntimeError, ValueError):
            rv = None
    if not rv:
        return {**out, "status": "untracked", "note": "no version upstream"}
    return {**out, "remoteVersion": rv, "status": "outdated" if rv != iv else "current"}


def installed_plugins():
    out = subprocess.run(["claude", "plugin", "list", "--json"], capture_output=True, text=True, timeout=60)
    if out.returncode != 0:
        return []
    return [p for p in json.loads(out.stdout)
            if "@" in p["id"] and p["id"].split("@")[1] not in ("inline", "synced") and p.get("scope") != "session"]


# ---------- commands ----------

def check():
    sources = load_sources()
    try:
        markets = json.load(open(MARKETPLACES))
    except (OSError, ValueError):
        markets = {}
    jobs = [(check_skill, s, sources) for s in discover_skills()]
    jobs += [(check_plugin, p, markets) for p in installed_plugins()]

    def run(job):
        fn, item, extra = job
        try:
            return fn(item, extra)
        except Exception as err:  # one item failing never sinks the report
            label = item.get("name") or item.get("id")
            kind = item.get("kind", "plugin")
            return {"id": f"{kind}:{item.get('id', label)}", "kind": kind, "name": label.split("@")[0],
                    "status": "error", "note": str(err)[:200]}

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        items = list(pool.map(run, jobs))
    order = {"outdated": 0, "error": 1, "current": 2, "untracked": 3}
    items.sort(key=lambda i: (order.get(i["status"], 9), i["kind"], i["name"]))
    return {"checkedAt": int(time.time() * 1000), "items": items}


def find_item(item_id):
    kind, _, rest = item_id.partition(":")
    if kind == "plugin":
        return {"kind": "plugin", "id": rest}
    for s in discover_skills():
        if s["kind"] == kind and s["name"] == rest:
            return s
    raise RuntimeError(f"no skill {item_id}")


def update(item_id):
    item = find_item(item_id)
    if item["kind"] == "plugin":
        pid = item["id"]
        mk = pid.split("@")[1]
        subprocess.run(["claude", "plugin", "marketplace", "update", mk], capture_output=True, timeout=180)
        out = subprocess.run(["claude", "plugin", "update", pid], capture_output=True, text=True, timeout=300)
        if out.returncode != 0:
            raise RuntimeError((out.stderr or out.stdout).strip().splitlines()[-1] if (out.stderr or out.stdout) else "update failed")
        return {"ok": True, "message": f"{pid.split('@')[0]} updated: applies in your next session"}

    report = check_skill(item, load_sources())
    if report["status"] != "outdated":
        return {"ok": True, "message": f"{item['name']} is already current"}
    repo, sha, path = report["repo"], report["remoteSha"], report["path"]
    label = report.get("remoteVersion") or sha[:7]
    with tempfile.TemporaryDirectory() as tmp:
        staged = os.path.join(tmp, item["name"])
        os.makedirs(staged)
        fetch_skill(repo, sha, path, staged)
        if item["kind"] == "personal":
            os.makedirs(BACKUPS, exist_ok=True)
            backup = os.path.join(BACKUPS, f"{item['name']}-{time.strftime('%Y%m%d-%H%M%S')}")
            shutil.move(item["dir"], backup)
            shutil.move(staged, item["dir"])
            return {"ok": True, "message": f"{item['name']} updated to {label}; old copy in {backup}"}
        zip_path = os.path.join(DESKTOP, f"{item['name']}-{label}.zip")
        if os.path.exists(zip_path):
            os.remove(zip_path)
        subprocess.run(["ditto", "-c", "-k", "--noextattr", "--norsrc", "--keepParent", staged, zip_path],
                       check=True, timeout=60)
        subprocess.run(["open", "-R", zip_path], timeout=10)
        return {"ok": True, "zip": zip_path, "remoteSha": sha,
                "message": f"{os.path.basename(zip_path)} is on your Desktop: upload it on claude.ai to replace {item['name']}"}


def main():
    try:
        if sys.argv[1:2] == ["check"]:
            result = check()
        elif sys.argv[1:2] == ["update"] and len(sys.argv) == 3:
            result = update(sys.argv[2])
        else:
            result = {"ok": False, "message": "usage: skill_updates.py check | update <id>"}
    except Exception as err:
        result = {"ok": False, "message": str(err)[:300]}
    json.dump(result, sys.stdout)


if __name__ == "__main__":
    main()
