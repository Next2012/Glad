#!/usr/bin/env python3
"""候选与正式发布共用的 Git 上下文和全量附件摘要检查。"""

import argparse
import gzip
import hashlib
import json
import re
import subprocess
import tarfile
from pathlib import Path


def git(*args):
    return subprocess.check_output(["git", *args], text=True).strip()


def identity():
    if git("status", "--porcelain", "--untracked-files=all"):
        raise ValueError("发布源码必须是干净提交")
    revision = git("rev-parse", "HEAD")
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("源码提交无效")
    return revision


def context(version):
    identity()
    # 候选和正式均只保留 HEAD 这一层历史, 避免历史 tag 改变 Go module 版本。
    if git("rev-list", "--count", "HEAD") != "1":
        raise ValueError("请使用 fetch-depth: 1 的独立 checkout 构建候选和正式产物")
    for tag in git("tag", "--list").splitlines():
        subprocess.run(
            ["git", "tag", "--delete", tag], check=True, stdout=subprocess.DEVNULL
        )
    subprocess.run(["git", "tag", "v" + version, "HEAD"], check=True)
    # 本地 tag 仅用于相同构建上下文, 关闭该 checkout 的推送入口。
    for remote in git("remote").splitlines():
        subprocess.run(
            ["git", "remote", "set-url", "--push", remote, "disabled://candidate-tags"],
            check=True,
        )


def binary(path):
    revision = identity()
    output = subprocess.check_output(["go", "version", "-m", str(path)], text=True)
    fields = dict(re.findall(r"^\s*build\s+(vcs\.[a-z]+)=(.*)$", output, re.MULTILINE))
    if fields.get("vcs.revision") != revision or fields.get("vcs.modified") != "false":
        raise ValueError("二进制必须携带当前干净源码的 VCS 身份")


def checksums(directory, names):
    if not names or len(names) != len(set(names)):
        raise ValueError("必须提供不重复的完整必交付资产列表")
    values = {}
    for name in names:
        if Path(name).name != name or name in {".", ".."}:
            raise ValueError("资产名称必须是单一文件名")
        path = directory / name
        if not path.is_file() or path.is_symlink():
            raise ValueError("缺少必交付资产: " + name)
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1 << 20), b""):
                digest.update(chunk)
        values[name] = digest.hexdigest()
    return values


def record(version, directory, names):
    return {
        "schema": "release-candidate/v1",
        "version": version,
        "revision": identity(),
        "assets": checksums(directory, names),
    }


def verify(version, directory, names, approved):
    actual = record(version, directory, names)
    # 名单、版本、提交、每个摘要必须完全相同, 缺审批文件不能转为重新生成。
    expected = json.loads(approved.read_text())
    if expected != actual:
        raise ValueError(
            "已验收候选与正式产物的版本、提交、资产集合或摘要不一致, 禁止发布"
        )


def check_tag(version, directory, names, approved):
    verify(version, directory, names, approved)
    tag = "refs/tags/v" + version
    existing = subprocess.run(
        ["git", "rev-parse", "--verify", tag + "^{commit}"],
        check=False,
        text=True,
        capture_output=True,
    )
    if existing.returncode == 0 and existing.stdout.strip() != identity():
        raise ValueError("正式 tag 已指向其他源码, 禁止沿用候选旧 tag")


def archive(source, output):
    # macOS 系统 tar 默认含当前时间, 改为标准库固定归档元数据。
    with (
        output.open("wb") as stream,
        gzip.GzipFile(filename="", mode="wb", fileobj=stream, mtime=0) as compressed,
        tarfile.open(fileobj=compressed, mode="w") as bundle,
    ):
        for path in sorted(source.rglob("*")):
            if path.is_symlink():
                raise ValueError("发布归档不接受符号链接")
            if not path.is_file():
                continue
            info = bundle.gettarinfo(
                str(path), arcname=str(Path(source.name) / path.relative_to(source))
            )
            info.mtime = info.uid = info.gid = 0
            info.uname = info.gname = ""
            info.mode = 0o755 if path.stat().st_mode & 0o111 else 0o644
            with path.open("rb") as content:
                bundle.addfile(info, content)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command",
        choices=["context", "binary", "record", "verify", "check-tag", "archive"],
    )
    parser.add_argument("--version")
    parser.add_argument("--directory", type=Path)
    parser.add_argument("--asset", action="append", default=[])
    parser.add_argument("--output", type=Path)
    parser.add_argument("--approved", type=Path)
    args = parser.parse_args()
    try:
        if args.command in {
            "context",
            "record",
            "verify",
            "check-tag",
        } and not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", args.version or ""):
            raise ValueError("必须提供正式版本号")
        if args.command == "context":
            context(args.version)
        elif args.command == "binary":
            binary(args.directory)
        elif args.command == "archive":
            archive(args.directory, args.output)
        elif args.command == "record":
            value = record(args.version, args.directory, args.asset)
            args.output.write_text(json.dumps(value, sort_keys=True, indent=2) + "\n")
        else:
            if args.approved is None:
                raise ValueError("缺少已批准的候选摘要")
            if args.command == "check-tag":
                check_tag(args.version, args.directory, args.asset, args.approved)
            else:
                verify(args.version, args.directory, args.asset, args.approved)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, str(error) + "\n")


if __name__ == "__main__":
    main()
