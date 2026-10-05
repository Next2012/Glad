# 候选验收与正式发布门禁

1. 所有同批源码、版本、依赖和索引先冻结为干净提交。分支后续有变化必须重新生成并验收候选。
2. 通过下述 workflow_dispatch 生成候选。候选和正式都使用深度为 1 的独立 checkout；release_gate.py context 只在该 checkout 创建本地版本 tag，并禁用其推送。
3. 下载 release-assets（BotLink 为 candidate-controller-assets）和 candidate-checksums，部署这些字节做验收。macOS 也由同一次候选 CI 构建，不用会创建正式 Release 的旧入口。
4. 全部必测通过后，记录该候选的成功 run ID，设置下述批准变量。变量不设置时正式发布会失败。run 必须来自对应候选 workflow、同一冻结提交；摘要记录的版本、提交和全部资产也必须一致。
5. 创建或推送正式 Git tag 前，在相同冻结提交再次 dispatch 候选构建 workflow，设置 verify_approved=true。它在全部目标平台重新构建，并执行与正式发布相同的批准摘要比较；dispatch 始终只生成附件，不创建 Release、不发 NPM。必须等这次预检整个 run 成功，才能给新产物占用正式 Git tag。
6. 下载本次预检的新产物到 fresh_build_assets。在另一个干净、指向最终验收提交的 checkout 中执行以下检查。须使用新构建附件，禁止拿已验收候选与自己比较来替代预检；--asset 列表须完整，取自下述“必选资产”。

```bash
python3 scripts/release_gate.py check-tag --version "$release_version" \
  --directory "$fresh_build_assets" --approved "$accepted_checksums" \
  --asset <每个必选资产分别提供一次>
```

check-tag 不创建或推送 tag。它检查候选字节、版本、最终源码 SHA，已有版本 tag 指向其他提交时失败。通过后才用现有正式发布入口，在此最终提交创建/推送正式 tag；禁止推候选 checkout 的本地 tag，也禁止复用候选旧提交上的 tag。
7. 正式 CI 重新构建全部 Go/npm 资产，逐项与批准候选比较；任何差异会在 NPM/GitHub Release 或正式交付附件前停止。它不能拦截管理员在外部直接推 tag，因此第 5–6 步是推 tag 前的必做检查。

仓库变量是验收后的显式批准记录，不能为绕过失败随意改为最新 run。原候选附件与摘要必须保留。

## Glad

- 候选：Release workflow_dispatch，输入与 package.json 相同的 version；只产附件，不发布 NPM/GitHub Release。
- 批准变量：APPROVED_CANDIDATE_RUN_ID。
- 必选资产：glad-linux-amd64、glad-linux-arm64、glad-windows-amd64.exe、glad-macos-x64、glad-macos-arm64、SHA256SUMS，以及下列六种 npm 包的 VERSION.tgz：
  - glad-web
  - glad-web-linux-x64
  - glad-web-linux-arm64
  - glad-web-darwin-x64
  - glad-web-darwin-arm64
  - glad-web-windows-x64
- 候选和正式 npm 包均由固定 Node 24.18.0、npm 11.16.0 生成；发布的就是通过全量比较的 tgz。不能重打一个未经比较的 npm 包再发布。
