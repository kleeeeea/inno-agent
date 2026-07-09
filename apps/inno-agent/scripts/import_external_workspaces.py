from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
from pathlib import Path


path = '/Users/l/other_git_repos/EduClaw-js/scripts/export/exported_workspaces'
# add workspaces from the above path into target_presets_path, that can be read from /Users/l/other_git_repos/inno-agent/apps/inno-agent/src/presets/preset-store.ts,
target_presets_path = '/Users/l/other_git_repos/inno-agent/apps/inno-agent/presets'
# generated doc for presets: /Users/l/other_git_repos/inno-agent/apps/inno-agent/scripts/docs/presets_format.md
default_import_subfolder = 'external-workspaces'


PRESET_ID_RE = re.compile(r"^[a-zA-Z0-9._-]+$")
MAX_DESCRIPTION_CHARS = 96


def slugify(name: str) -> str:
    """Create a preset-store-compatible id from an external workspace name."""
    ascii_name = name.encode("ascii", "ignore").decode("ascii").lower()
    slug = re.sub(r"[^a-z0-9._-]+", "-", ascii_name).strip(".-_")
    digest = hashlib.sha1(name.encode("utf-8")).hexdigest()[:8]
    if not slug:
        slug = "workspace"
    candidate = f"{slug}-{digest}"
    return candidate if PRESET_ID_RE.fullmatch(candidate) else f"workspace-{digest}"


def clean_title(name: str) -> str:
    """Use the source folder name as display name, dropping duplicate suffixes."""
    return re.sub(r"_[0-9a-fA-F]{8}$", "", name).strip() or name


def first_content_paragraph(markdown: str) -> str:
    """Extract a short card description from agents.md."""
    lines: list[str] = []
    in_code = False
    for raw in markdown.splitlines():
        line = raw.strip()
        if line.startswith("```"):
            in_code = not in_code
            continue
        if in_code or not line:
            if lines:
                break
            continue
        if line.startswith("#"):
            continue
        if line in {"---", "***"}:
            continue
        line = re.sub(r"^[-*+]\s+", "", line)
        line = re.sub(r"^\d+[.)]\s+", "", line)
        line = re.sub(r"\*\*(.*?)\*\*", r"\1", line)
        line = re.sub(r"`([^`]+)`", r"\1", line)
        lines.append(line)
        if len(" ".join(lines)) >= MAX_DESCRIPTION_CHARS:
            break

    description = " ".join(lines).strip()
    if len(description) > MAX_DESCRIPTION_CHARS:
        description = description[: MAX_DESCRIPTION_CHARS - 1].rstrip() + "…"
    return description


def copy_workspace_contents(source_dir: Path, target_dir: Path) -> None:
    """Copy exported workspace files into the preset, renaming agents.md."""
    target_dir.mkdir(parents=True, exist_ok=True)
    for item in source_dir.iterdir():
        if item.name in {".DS_Store", "__MACOSX"}:
            continue
        target_name = "agent.md" if item.name == "agents.md" else item.name
        target = target_dir / target_name
        if item.is_dir():
            shutil.copytree(item, target, dirs_exist_ok=True)
        elif item.is_file():
            shutil.copy2(item, target)


def import_workspace(source_dir: Path, target_root: Path, preset_id: str, force: bool) -> str:
    target_dir = target_root / preset_id
    if target_dir.exists():
        if not force:
            return "skipped"
        shutil.rmtree(target_dir)

    agents_md = source_dir / "agents.md"
    if not agents_md.is_file():
        return "missing-agents"

    agent_text = agents_md.read_text(encoding="utf-8")
    copy_workspace_contents(source_dir, target_dir)

    preset = {
        "id": preset_id,
        "name": clean_title(source_dir.name),
        "description": first_content_paragraph(agent_text),
        "category": "教学",
        "icon": "graduation-cap",
    }
    (target_dir / "preset.json").write_text(
        json.dumps(preset, ensure_ascii=False, indent="\t") + "\n",
        encoding="utf-8",
    )
    return "imported"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Import exported EduClaw workspaces as inno-agent presets.",
    )
    parser.add_argument("--source", default=path, help="Directory containing exported workspaces.")
    parser.add_argument("--target", default=target_presets_path, help="Target inno-agent presets directory.")
    parser.add_argument("--subfolder", default=default_import_subfolder, help="Subfolder under --target for imported presets; pass an empty string to import at target root.")
    parser.add_argument("--force", action="store_true", help="Overwrite target preset folders when ids collide.")
    parser.add_argument("--limit", type=int, default=0, help="Import at most N workspaces; 0 means no limit.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    source_root = Path(args.source).expanduser().resolve()
    target_root = Path(args.target).expanduser().resolve()
    if args.subfolder:
        target_root = target_root / args.subfolder

    if not source_root.is_dir():
        raise SystemExit(f"source directory not found: {source_root}")
    target_root.mkdir(parents=True, exist_ok=True)

    stats = {"imported": 0, "skipped": 0, "missing-agents": 0}

    workspaces = [p for p in sorted(source_root.iterdir(), key=lambda x: x.name) if p.is_dir() and not p.name.startswith((".", "_"))]
    if args.limit > 0:
        workspaces = workspaces[: args.limit]

    for source_dir in workspaces:
        preset_id = slugify(source_dir.name)
        status = import_workspace(source_dir, target_root, preset_id, args.force)
        stats[status] = stats.get(status, 0) + 1
        print(f"{status:14} {source_dir.name} -> {preset_id}")

    print(
        "done: "
        + ", ".join(f"{key}={value}" for key, value in sorted(stats.items()))
        + f", target={target_root}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
