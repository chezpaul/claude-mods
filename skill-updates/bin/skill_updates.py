#!/usr/bin/env python3
"""Check installed skills and plugins against their GitHub sources, and update them.

  skill_updates.py check            -> JSON report on stdout
  skill_updates.py update <id>      -> JSON result on stdout
  skill_updates.py synced           -> when the claude.ai skills last synced to this Mac
  skill_updates.py trash <zip>      -> moves a zip this script built on the Desktop to the Trash

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
import itertools
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
DESKTOP_SYNCED = os.path.join(HOME, "Library", "Application Support", "Claude", "local-agent-mode-sessions", "skills-plugin")
BACKUPS = os.path.join(HOME, ".claude", "skill-backups")
MARKETPLACES = os.path.join(HOME, ".claude", "plugins", "known_marketplaces.json")
DESKTOP = os.path.join(HOME, "Desktop")
MOD_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCES = os.path.join(MOD_ROOT, "sources.json")

GH_URL = re.compile(r"github\.com[/:]([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?(?=[/)\s\"'#?]|$)", re.M)
VERSION = re.compile(r"^\s*version:\s*[\"']?([^\"'\n]+?)[\"']?\s*$", re.M)
HEX = re.compile(r"^[0-9a-f]{7,40}$")
NAME = re.compile(r"^\s*name:\s*[\"']?([^\"'\n]+?)[\"']?\s*$", re.M)
SAFE_VERSION = re.compile(r"^[\w.+-]{1,40}$")
SAFE_NAME = re.compile(r"^[\w.-]{1,64}$")
CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")
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


def frontmatter(text):
    return text.split("\n---", 1)[0] if text.startswith("---") else ""


def version_of(text):
    m = VERSION.search(frontmatter(text) or text[:2000])
    v = m.group(1).strip() if m else None
    # Versions come from GitHub and are drawn in the pane: keep plain ones only.
    return v if v and SAFE_VERSION.match(v) else None


def name_of(text):
    m = NAME.search(frontmatter(text))
    return m.group(1).strip() if m else None


def same_skill_md(local_text, upstream_text):
    """claude.ai re-writes SKILL.md's frontmatter on upload (quotes, folded lines),
    so the frontmatter is compared by its words and the body byte for byte."""
    def split(text):
        if text.startswith("---"):
            head, sep, body = text[3:].partition("\n---")
            if sep:
                return head, body
        return "", text

    def words(head):
        head = head.replace("\\n", " ").replace('\\"', '"')
        return sorted(re.sub(r"[\"'|>]", " ", head).split())

    (lh, lb), (uh, ub) = split(local_text), split(upstream_text)
    return lb.strip() == ub.strip() and words(lh) == words(uh)


def field(text, key):
    """One frontmatter value as plain text, folded and block scalars joined."""
    lines = frontmatter(text).splitlines()
    for i, line in enumerate(lines):
        m = re.match(rf"^{key}:\s*(.*)$", line)
        if not m:
            continue
        value = m.group(1).strip()
        if value in ("", ">", "|", ">-", "|-"):
            value = " ".join(l.strip() for l in itertools.takewhile(lambda l: not l.strip() or l[0] in " \t", lines[i + 1:]))
        return value.strip("\"'")
    return ""


def listing_tokens(text, name=None):
    """Rough tokens the session's skill/agent listing spends on this file every message:
    its name and description (about 4 characters a token)."""
    line = f"- {name or field(text, 'name')}: {field(text, 'description')} {field(text, 'when_to_use')}"
    return round(len(line.strip()) / 4)


LISTED = re.compile(r"^(?:skills/[^/]+/SKILL\.md|agents/[^/]+\.md|commands/[^/]+\.md)$")


def plugin_listing_tokens(paths, read):
    """Listing tokens of a plugin's skills, agents and commands, by their paths in the plugin."""
    return sum(listing_tokens(read(p)) for p in paths if LISTED.match(p))


def clean(value, limit=200):
    return CONTROL.sub("", str(value))[:limit] if value is not None else None


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

def synced_copies():
    found = []
    if os.path.isdir(SYNCED):
        found += [os.path.join(SYNCED, b) for b in sorted(os.listdir(SYNCED)) if not b.startswith(".")]
    if os.path.isdir(DESKTOP_SYNCED):
        for org in sorted(os.listdir(DESKTOP_SYNCED)):
            o = os.path.join(DESKTOP_SYNCED, org)
            if os.path.isdir(o):
                found += [os.path.join(o, b) for b in sorted(os.listdir(o)) if not b.startswith(".")]
    return found


def discover_skills():
    items = []
    for name in sorted(os.listdir(SKILLS)):
        d = os.path.join(SKILLS, name)
        if name.startswith(".") or name == "synced" or not SAFE_NAME.match(name) or not os.path.isfile(os.path.join(d, "SKILL.md")):
            continue
        items.append({"kind": "personal", "name": name, "dir": d})
    # Two copies of your claude.ai skills can be on disk: the desktop app's and
    # the CLI's. Either can lag the other, so read the one synced last.
    best = None
    for b in synced_copies():
        try:
            with open(os.path.join(b, "manifest.json")) as f:
                manifest = json.load(f)
        except (OSError, ValueError):
            continue
        if best is None or manifest.get("lastUpdated", 0) > best[1].get("lastUpdated", 0):
            best = (b, manifest)
    if best:
        b, manifest = best
        root = os.path.join(b, "skills") if os.path.isdir(os.path.join(b, "skills")) else b
        for s in manifest.get("skills", []):
            name = s.get("name", "")
            d = os.path.join(root, name)
            # Anthropic's own skills update themselves; only your uploads are checked.
            anthropic = str(s.get("source") or s.get("creatorType") or "").startswith("anthropic")
            if not anthropic and SAFE_NAME.match(name) \
                    and os.path.isfile(os.path.join(d, "SKILL.md")):
                items.append({"kind": "claudeai", "name": name, "dir": d})
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
        # A link in a skill's files is only a guess at its source: the repo's
        # SKILL.md has to name the same skill before it can replace this one.
        if name_of(upstream_md) != name:
            if override:
                return {**out, "repo": repo, "status": "error", "note": "the repo's SKILL.md names another skill"}
            continue
        want = compared_files(files, path, upstream_md, d)
        changed = [p for p, s in want.items()
                   if not os.path.isfile(os.path.join(d, p))
                   or (blob_sha(os.path.join(d, p)) != s
                       and not (p == "SKILL.md" and same_skill_md(local_md, upstream_md)))]
        report = {**out, "repo": repo, "path": path, "remoteSha": sha, "remoteVersion": version_of(upstream_md),
                  "source": "sources.json" if override else "link in the skill",
                  "status": "outdated" if changed else "current", "changed": changed[:20]}
        if changed:
            report["tokenDelta"] = listing_tokens(upstream_md, name) - listing_tokens(local_md, name)
        return report
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


def plugin_token_delta(p, repo, path):
    """How many more listing tokens the upstream plugin spends each message than the installed one."""
    local = p.get("installPath") or ""
    if not os.path.isdir(local):
        return None
    local_files = []
    for root, _, files in os.walk(local):
        local_files += [os.path.relpath(os.path.join(root, f), local) for f in files]
    here = plugin_listing_tokens(local_files, lambda r: open(os.path.join(local, r), encoding="utf-8", errors="replace").read())
    sha, tree = repo_tree(repo)
    prefix = path + "/" if path else ""
    upstream = [f[len(prefix):] for f in tree if f.startswith(prefix)]
    if sum(1 for f in upstream if LISTED.match(f)) > 80:
        return None
    there = plugin_listing_tokens(upstream, lambda r: gh_file(repo, prefix + r, sha))
    return there - here


def check_plugin(p, markets):
    report = check_plugin_version(p, markets)
    # A disabled plugin costs nothing either way.
    if report["status"] == "outdated" and p.get("enabled") and report.get("repo"):
        try:
            report["tokenDelta"] = plugin_token_delta(p, report["repo"], report.pop("path", ""))
        except (RuntimeError, OSError, ValueError):
            pass
    report.pop("path", None)
    return report


def check_plugin_version(p, markets):
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
    out["repo"], out["path"] = repo, path
    if HEX.match(iv):
        cmp = gh(f"repos/{repo}/compare/{iv}...HEAD")
        head = cmp["commits"][-1]["sha"] if cmp.get("commits") else None
        touched = [f["filename"] for f in cmp.get("files", []) if not path or f["filename"].startswith(path + "/")]
        outdated = cmp.get("ahead_by", 0) > 0 and bool(touched)
        return {**out, "remoteVersion": head[:12] if head and HEX.match(head) else iv, "status": "outdated" if outdated else "current"}
    rv = entry.get("version")
    if not rv:
        try:
            rv = json.loads(gh_file(repo, (path + "/" if path else "") + ".claude-plugin/plugin.json", "HEAD")).get("version")
        except (RuntimeError, ValueError):
            rv = None
    rv = str(rv) if rv is not None and SAFE_VERSION.match(str(rv)) else None
    if not rv:
        return {**out, "status": "untracked", "note": "no plain version upstream"}
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
    items = [{k: (clean(v) if isinstance(v, str) else v) for k, v in i.items()} for i in items]
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


def synced():
    stamps = []
    for b in synced_copies():
        try:
            with open(os.path.join(b, "manifest.json")) as f:
                stamps.append(int(json.load(f).get("lastUpdated", 0)))
        except (OSError, ValueError, TypeError):
            continue
    return {"ok": True, "lastUpdated": max(stamps, default=0)}


def trash(zip_path):
    """Only a zip this script names (on the Desktop, <skill>-<version>.zip) goes."""
    real = os.path.realpath(zip_path)
    base = os.path.basename(real)
    if os.path.dirname(real) != os.path.realpath(DESKTOP) or not base.endswith(".zip") \
            or not SAFE_NAME.match(base[:-4]):
        return {"ok": False, "message": "not a zip this mod built"}
    if not os.path.isfile(real):
        return {"ok": True, "message": f"{base} was already gone"}
    subprocess.run(["/usr/bin/trash", real], check=True, capture_output=True, timeout=30)
    return {"ok": True, "message": f"{base} moved to the Trash"}


def main():
    try:
        if sys.argv[1:2] == ["check"]:
            result = check()
        elif sys.argv[1:2] == ["update"] and len(sys.argv) == 3:
            result = update(sys.argv[2])
        elif sys.argv[1:2] == ["synced"]:
            result = synced()
        elif sys.argv[1:2] == ["trash"] and len(sys.argv) == 3:
            result = trash(sys.argv[2])
        else:
            result = {"ok": False, "message": "usage: skill_updates.py check | update <id> | synced | trash <zip>"}
    except Exception as err:
        result = {"ok": False, "message": str(err)[:300]}
    if isinstance(result.get("message"), str):
        result["message"] = clean(result["message"], 500)
    json.dump(result, sys.stdout)


if __name__ == "__main__":
    main()
