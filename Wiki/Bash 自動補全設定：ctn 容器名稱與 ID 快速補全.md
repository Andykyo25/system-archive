# Bash 自動補全設定：`ctn` 容器名稱與 ID 快速補全

**適用情境**：  
在日常 DevOps 操作中，頻繁使用 `docker exec -it <container> /bin/bash` 進入容器。  
透過自訂指令 `ctn` + **TAB 自動補全**，可直接補全 **容器 ID 或 Name**，大幅提升效率。

> **效果**：  
> ```bash
> ctn <TAB><TAB>        → 列出所有運行中容器（ID + Name）
> ctn gitlab<TAB>       → 自動補全為 ctn gitlab-web-1
> ```

---

## 一、適用對象與前提

| 項目 | 要求 |
|------|------|
| **作業系統** | Linux（Ubuntu / Debian / CentOS / Rocky / Alma / Amazon Linux 2 等） |
| **Shell** | Bash |
| **工具** | Docker 已安裝，`docker ps` 可執行 |
| **權限** | root 或 `sudo`（寫入 `/etc/bash_completion.d/`） |

---

## 二、步驟 1：建立 `ctn` 指令腳本

```bash
sudo tee /usr/bin/ctn > /dev/null <<'EOF'
#!/usr/bin/env bash
if [ $# -ne 1 ]; then
  echo -e "\nUsage: $0 {Container_name | Container ID}\n"
  exit 1
fi

docker exec -it "$1" /bin/bash
EOF
```

```bash
sudo chmod +x /usr/bin/ctn
```

> **效果**：  
> ```bash
> ctn gitlab-web-1    → 直接進入容器 bash
> ```

---

## 三、步驟 2：建立自動補全腳本

### 建立補全檔（系統級，影響所有使用者）

```bash
sudo tee /etc/bash_completion.d/ctn > /dev/null <<'EOF'
# /etc/bash_completion.d/ctn
# Docker 容器 ID + Name 自動補全 for ctn command

_ctn()
{
    local cur
    COMPREPLY=()
    cur="${COMP_WORDS[COMP_CWORD]}"

    # 取得運行中容器的 ID 和 Names（以空白分隔）
    local containers="$(docker ps --format '{{.ID}}\t{{.Names}}' | sed 's/\t/ /g')"

    # 產生補全選項
    COMPREPLY=( $(compgen -W "${containers}" -- "${cur}") )
    return 0
}

# 綁定補全函數到 ctn 指令
complete -F _ctn ctn
EOF
```

> **說明**：  
> - 使用 `{{.ID}}\t{{.Names}}` 確保 ID 與 Name 一一對應  
> - `sed 's/\t/ /g'` 轉為空白，方便 `compgen` 處理  
> - 支援 **部分字串補全**

---

### 若 `/etc/bash_completion.d/` 不存在，安裝 `bash-completion`

```bash
# Ubuntu / Debian
sudo apt-get update && sudo apt-get install -y bash-completion

# CentOS / RHEL / Rocky / Alma
sudo yum install -y bash-completion || sudo dnf install -y bash-completion
```

---

## 四、步驟 3：重新載入補全設定

### 方法 A：開新終端機（最簡單）
```bash
exit  # 或開新視窗
```

### 方法 B：立即載入（當前 session）
```bash
source /etc/bash_completion.d/ctn
```

> **個人設定**（僅自己）：  
> 將檔案放 `~/.bash_completion.d/ctn`，並加入 `~/.bashrc`：
> ```bash
> [ -f ~/.bash_completion.d/ctn ] && source ~/.bash_completion.d/ctn
> ```

---

## 五、步驟 4：驗證補全功能

```bash
ctn <TAB><TAB>
```

**預期輸出**：
```
123456789abc  gitlab-web-1
def123456789  postgres-sonar
abc987654321  sonarqube
```

```bash
ctn git<TAB>    → 自動補全為 ctn gitlab-web-1
```

---

## 六、進化版 `ctn`：智慧選擇 Shell（推薦）

```bash
sudo tee /usr/local/bin/ctn > /dev/null <<'EOF'
#!/usr/bin/env bash
if [ -z "$1" ]; then
  echo "用法：ctn <container-name-or-id> [shell]"
  echo "預設嘗試 /bin/bash，失敗則改用 /bin/sh"
  exit 1
fi

container="$1"
shell="${2:-/bin/bash}"

# 嘗試指定 shell
if docker exec -it "$container" "$shell" 2>/dev/null; then
  exit 0
else
  echo "[WARN] $shell not found, fallback to /bin/sh"
  docker exec -it "$container" /bin/sh
fi
EOF
```

```bash
sudo chmod +x /usr/local/bin/ctn
```

> **優點**：  
> - 支援 Alpine 等無 bash 的容器  
> - 可自訂 shell：`ctn mysql sh` 或 `ctn node zsh`

---

## 七、SE/DevOps 最佳實務建議

| 項目 | 建議 |
|------|------|
| **路徑優先權** | `/usr/local/bin` > `/usr/bin`，建議使用 `/usr/local/bin/ctn` |
| **補全範圍** | 可擴充支援 `docker stop`, `logs`, `rm` 等指令 |
| **僅運行中容器** | 若需包含停止容器，改用 `docker ps -a` |
| **多指令通用補全** | 可寫通用函數供多個 docker 指令使用 |
| **Zsh / Fish 支援** | 可進一步移植為跨 Shell 工具 |

---

## 八、擴充範例：通用 Docker 補全函數

```bash
_docker_containers() {
    local containers="$(docker ps --format '{{.ID}} {{.Names}}')"
    COMPREPLY=( $(compgen -W "$containers" -- "$cur") )
}

complete -F _docker_containers ctn
complete -F _docker_containers dstop  # 自訂 docker stop 快捷
```

---

**完成！**  
您現在擁有：
- `ctn <TAB>` → 智慧補全容器  
- 自動 fallback shell  
- 系統級自動補全，團隊共享  

> **專業小技巧**：  
> 搭配 `alias d='docker'`、`dkill='docker kill'` 等，打造極致高效 Docker 工作流。
