# lsyncd 配置方式

***lsyncd和rsync有什麼不同？***
lsyncd 和 rsync 都是用於文件同步的工具,但是它們有一些重要的差異:

**1. 工作方式不同:**
   - lsyncd 是一個實時監控文件變化並觸發 rsync 同步的守護進程。它採用事件驅動(inotify)的方式,當監控的文件有變化時立即觸發 rsync 同步。
   - rsync 則是一個單純的文件同步工具,需要手動運行或配合其他調度工具(如 cron)運行。

**2. 適用場景不同:**
   - lsyncd 適用於需要實時同步的場景,如內容管理系統、開發環境等。它可以快速響應文件變化並增量同步,提高效率。
   - rsync 更適合用於批量、定時的同步任務,如系統備份、定期同步等。它具有更強大的同步功能和選項,適用於更複雜的同步需求。

**3. 功能差異:**
   - lsyncd 功能較簡單,主要專注於實時監控和觸發 rsync 同步。
   - rsync 提供更多的功能和選項,如遞歸同步、壓縮傳輸、排除文件等。

# 如何透過 lsyncd 將 A機器 資料同步到 B機器
以下皆在 A機器操作，新增 lsyncd.conf 配置

`vi /etc/lsyncd.conf`

```markdown
-- 用於 lsyncd 的使用者配置文件。
-- 這是一個簡單的預設 rsync 範例，但在目標端執行移動。
-- 欲查看更多範例，請參見 /usr/share/doc/lsyncd*/examples/
-- sync{default.rsyncssh, source="/var/www/html", host="localhost", targetdir="/tmp/htmlcopy/"}

settings {
    logfile = "/var/log/lsyncd/lsyncd.log",
    statusFile = "/var/log/lsyncd/lsyncd-status.log",
    statusInterval = 10,
    insist = true
}
---------------------------------------------------------------------------------- dp3-sync-002
    sync {
        -- rsync , rsyncssh , direct 三種模式
        default.rsync,
        source="/var/static/",
        target="root@dp3-sync-002::static",
        delete = true,
        delay = 20,
        maxProcesses = 2,
        exclude = { ". *", ".tmp","* .zip"},
        rsync = {
            bwlimit = 20000,
            compress = true,
            acls = true,
            verbose = true,
            owner = true,
            group = true,
            perms = true
        }
    }
}
```
注意事項：
1. 原本預設的註釋 sync{default.rsyncssh....

2. target 要去哪一個模塊，要對照 rsync 配置（/etc/rsyncd.conf），以 static 為例
```markdown
[static]
path = /var/static/
hosts allow = 20.206.203.234
hosts deny = *
list = no
uid = root
gid = root
read only = no
exclude = .git/ .idea/
```

3. rsync 如何知道機器是誰（target="root@dp3-sync-002::static"），透過 /etc/hosts
```markdown
[22::root@dp3-sync-001::~]# >>>cat /etc/hosts
127.0.0.1 localhost
10.158.0.9 dp3-sync-001.southamerica-east1-a.c.dp3-siteout.internal dp3-sync-001  # Added by Google
169.254.169.254 metadata.google.internal  # Added by Google
10.158.0.9       dp3-sync-001 dp3-sync-001
20.206.203.234   dp3-sync-002
```

4. 兩台機器記得確認是否有通

---

確認配置完畢後，重起服務

`systemctl restart lsyncd.service`

確認無報錯後，新增一個檔案並看是否有同步過去