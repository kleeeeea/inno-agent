remote preset 下载到这里：

```ts
paths.presetCacheDir
```

也就是代码注释里的：

```txt
<dataDir>/preset-cache/<presetId>/
```

对应函数是：

```ts
export function presetsDir(paths: RuntimePaths): string {
	return paths.presetCacheDir;
}
```

在 `ensurePresetCached()` 里具体拼出来：

```ts
const root = presetsDir(paths);
const cacheDir = join(root, id);
```

然后远程下载发生在这里：

```ts
await source.downloadItem("presets", id, cacheDir);
```

所以如果 `presetId = "math-tutor"`，下载位置就是：

```txt
<dataDir>/preset-cache/math-tutor/
```

里面应该包含：

```txt
preset.json
agent.md
.skills/
...
```

之后 `instantiatePreset()` 会从这个 cache 目录复制到真正的 workspace：

```ts
const srcDir = join(root, id);      // <dataDir>/preset-cache/<id>
const destDir = registry.resolveWorkspaceDir(ws.id); // workspace 目录

copyPresetContents(srcDir, destDir);
```

注意：remote 不会直接下载到 workspace，而是先下载到 **preset cache**，再由 cache 实例化到 workspace。
