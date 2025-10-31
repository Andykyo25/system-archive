# SonarQube 配置與 GitLab CI 整合完整指南

**適用情境**：  
在 Docker 環境中部署 **SonarQube + PostgreSQL**，並整合至 **GitLab CI/CD** 流程，實現自動程式碼品質掃描、Quality Gate 檢查，適用於 Kubernetes、微服務或任何 Git 專案。

> **SE/DevOps 最佳實務**：SonarQube 應部署於獨立 VPC/子網，僅允許 GitLab Runner 與管理員存取；生產環境建議使用 HTTPS + 基本認證。

---

## 一、架構總覽

```
GitLab → GitLab Runner (Docker Executor) → SonarQube Server → PostgreSQL
```

- SonarQube：程式碼靜態分析平台  
- GitLab Runner：執行 `sonar-scanner` 掃描  
- PostgreSQL：持久化資料庫  
- Quality Gate：CI 閘道，決定建置是否通過  

---

## 二、步驟一：部署 SonarQube 容器（`docker-compose.yml`）

```yaml
version: '3.8'

services:
  sonarqube:
    image: sonarqube:community  # 建議使用 :10.6-community 或指定版本
    container_name: sonarqube
    depends_on:
      - db
    environment:
      - SONAR_JDBC_URL=jdbc:postgresql://db:5432/sonarqube
      - SONAR_JDBC_USERNAME=sonar
      - SONAR_JDBC_PASSWORD=sonar123
    ports:
      - "9000:9000"  # 正式環境建議反向代理 + HTTPS
    volumes:
      - sonarqube_data:/opt/sonarqube/data
      - sonarqube_logs:/opt/sonarqube/logs
      - sonarqube_extensions:/opt/sonarqube/extensions
    networks:
      - sonar-network
    restart: unless-stopped
    ulimits:
      nofile: 65536
      nproc: 4096

  db:
    image: postgres:15
    container_name: postgres-sonar
    environment:
      - POSTGRES_USER=sonar
      - POSTGRES_PASSWORD=sonar123
      - POSTGRES_DB=sonarqube
    volumes:
      - postgres_data:/var/lib/postgresql/data
    networks:
      - sonar-network
    restart: unless-stopped

volumes:
  sonarqube_data:
  sonarqube_logs:
  sonarqube_extensions:
  postgres_data:

networks:
  sonar-network:
    driver: bridge
```

### 啟動指令
```bash
docker compose up -d
```

> **注意**：首次啟動需 2~5 分鐘初始化資料庫與索引。

---

## 三、步驟二：首次登入與中文化

1. 瀏覽器開啟：`http://<伺服器IP>:9000`
2. 預設帳號：
   - **Login**: `admin`
   - **Password**: `admin`
3. 系統會強制要求變更密碼

### 中文化設定（選用）

參考：[SonarQube 中文語言包安裝](https://blog.csdn.net/liumiaocn/article/details/103043922)

```bash
# 下載中文語言包
wget -O sonarqube-chinese-pack.jar \
  https://github.com/SonarOpenCommunity/sonar-l10n-zh/releases/download/sonar-l10n-zh-plugin-10.6/sonar-l10n-zh-plugin-10.6.jar

# 放入 extensions 目錄並重啟
sudo cp sonar-l10n-zh-plugin-*.jar ./sonarqube_extensions/plugins/
docker compose restart sonarqube
```

→ 登入後：`Administration → General → Localization → Language: 简体中文`

---

## 四、步驟三：專案端設定 `sonar-project.properties`

放在 Git 專案**根目錄**：

```properties
# 專案唯一識別
sonar.projectKey=your-org:your-project-name
sonar.projectName=Your Project Name
sonar.projectVersion=1.0

# 來源碼路徑
sonar.sources=.
sonar.exclusions=**/*_test.go, **/vendor/**, **/node_modules/**

# 語言設定（依專案調整）
sonar.language=java  # 或 js, py, go 等
sonar.sourceEncoding=UTF-8

# 掃描報告輸出（可選）
sonar.ws.timeout=300
```

> **多模組專案**：使用 `sonar.modules` 定義子模組。

---

## 五、步驟四：部署 GitLab Runner（專用 Sonar 掃描）

### 1. 建立 Runner 設定檔 `docker-compose.runner.yml`

```yaml
version: '3.8'

services:
  gitlab-runner:
    image: gitlab/gitlab-runner:ubuntu-v16.2.0
    container_name: ws-sonar-qube-runner
    privileged: true
    restart: always
    network_mode: host
    volumes:
      - /srv/gitlab-runner/config:/etc/gitlab-runner
      - /var/run/docker.sock:/var/run/docker.sock
      - /usr/bin/docker:/usr/bin/docker
    tty: true
    stdin_open: true
```

### 2. 建立設定目錄
```bash
sudo mkdir -p /srv/gitlab-runner/config
```

### 3. 取得 GitLab Runner Registration Token

> GitLab 路徑：  
> `Project → Settings → CI/CD → Runners → New project runner`

### 4. **一次性註冊 Runner**（僅執行一次）

```bash
sudo docker run --rm -it \
  -v /srv/gitlab-runner/config:/etc/gitlab-runner \
  gitlab/gitlab-runner:alpine register --non-interactive \
  --url "https://<你的 GitLab 網址>" \
  --registration-token "<你的 Registration Token>" \
  --executor "docker" \
  --docker-image "sonarsource/sonar-scanner-cli:latest" \
  --description "sonar-runner-01" \
  --tag-list "sonar,quality-gate" \
  --run-untagged="false" \
  --locked="false"
```

### 5. 啟動 Runner
```bash
docker compose -f docker-compose.runner.yml up -d
```

> 檢查 GitLab 是否顯示 Runner 為 **Online**

---

## 六、步驟五：GitLab CI 加入 Sonar 掃描任務

在 `.gitlab-ci.yml` 中加入：

```yaml
dev-k8s-check:
  stage: dev-k8s-check
  tags:
    - sonar,quality-gate  # 對應 Runner 的 tag
  rules:
    - if: $CI_MERGE_REQUEST_LABELS == 'ws-k8s-dev' && $CI_PIPELINE_SOURCE == 'merge_request_event'
      when: on_success
  image:
    name: sonarsource/sonar-scanner-cli:5.0
    entrypoint: [""]
  variables:
    GIT_DEPTH: 0
    SONAR_HOST_URL: "http://<SonarQube_IP>:9000"  # 改為環境變數
    SONAR_TOKEN: $SONAR_TOKEN  # 從 GitLab CI Variables 注入
  cache:
    key: "${CI_JOB_NAME}"
    paths:
      - .sonar/cache
  script:
    - sonar-scanner \
        -Dsonar.projectKey=your-org:your-project-name \
        -Dsonar.host.url=$SONAR_HOST_URL \
        -Dsonar.login=$SONAR_TOKEN
  allow_failure: false  # Quality Gate 失敗時阻斷
  needs:
    - job: dev-k8s-build
      artifacts: true
```

---

## 七、步驟六：SonarQube 建立專案

1. 登入 SonarQube  
2. 點擊 **Create Project → Manually**  
3. 輸入：
   - Project key: `your-org:your-project-name`  
   - Display name: `Your Project Name`  
4. 選擇 **Generate a token** → 複製 Token

---

## 八、步驟七：GitLab 設定環境變數

> GitLab 路徑：  
> `Settings → CI/CD → Variables`

| Key | Value | Protected | Masked |
|-----|-------|----------|--------|
| `SONAR_HOST_URL` | `http://<IP>:9000` 或 `https://sonar.yourdomain.com` | Yes | No |
| `SONAR_TOKEN` | SonarQube 產生的 Token | Yes | Yes |

---

## 九、步驟八：Quality Gate 設定

1. SonarQube → **Quality Gates**  
2. 複製預設 `Sonar way` 或自訂條件：
   - New code 覆蓋率 < 80% → Fail  
   - 安全性漏洞 ≥ 1 → Fail  
   - 技術債 > 3 天 → Warn  
3. 套用至專案：`Projects → Administration → Quality Gate`

> **CI 阻斷**：Quality Gate 失敗 → Pipeline 失敗（`allow_failure: false`）

---

## 十、驗證與除錯

| 項目 | 指令 |
|------|------|
| 查看 SonarQube 狀態 | `docker logs sonarqube` |
| 查看 Runner 狀態 | `docker logs ws-sonar-qube-runner` |
| 測試掃描（本地） | `sonar-scanner -Dsonar.projectKey=test -Dsonar.host.url=http://ip:9000 -Dsonar.login=token` |
| 查看掃描結果 | SonarQube 專案頁面 → Issues / Measures |

---

## 十一、SE/DevOps 最佳實務建議

| 項目 | 建議 |
|------|------|
| **HTTPS** | 使用 Nginx/Traefik 反向代理 + Let's Encrypt |
| **備份** | 定期備份 `sonarqube_data` 與 `postgres_data` |
| **升級** | 參考 [SonarQube Upgrade Guide](https://docs.sonarsource.com/sonarqube/latest/setup-and-upgrade/upgrade-the-built-in-database/) |
| **效能** | 生產環境建議 8GB+ RAM，啟用 Elasticsearch 索引 |
| **權限** | Runner 僅執行掃描，不應具管理權限 |
| **監控** | 整合 Prometheus + Grafana 監控 `sonar.web` 指標 |
| **多語言** | 安裝對應語言插件（Java, JS, Python, Go…） |

---

**完成！**  
您已成功部署 SonarQube 並整合至 GitLab CI，實現自動化程式碼品質閘道。

> **專業提醒**：  
> 建議將 `SONAR_HOST_URL` 改為內網域名（如 `sonar.internal`），避免暴露公網 IP。  
> 生產環境請啟用 **SonarQube Enterprise** 以支援分支分析與 PR Decoration。
