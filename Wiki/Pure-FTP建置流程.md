# Pure FTPd 建置

## 主要功能：外圍 sync 機器上，架設給開發上傳靜態檔案使用

1. 創建 host 上靜態檔案路徑
```
mkdir /var/static
chmod 755
chown ops.ops /var/static -R
```

2. 編寫啟動容器腳本，放置 ops 家目錄底下，並啟動
```
cat > ~/ftp.run << "EOF"
#!/bin/bash
# ftp.run
docker stop ftp
docker rm   ftp
docker run -itd --restart=always --hostname=ftp \
     --name ftp \
     -p 2121:21  -p 30000-30099:30000-30099 \
     -v /var/static:/data \
     -e "PUBLICHOST=localhost" \
hub.dayu-boss.com:10443/core/lb-ftp
EOF

chmod 755 ~/ftp.run
sh ftp.run

```
> 目前在gb-dl-001 /var/dl/deploy/ 有yaml可以參考，擷取需要的部份即可
{.is-info}


3. 配置pure ftp 容器內資訊

> 容器內創建與外層host相同 UID 的 user
{.is-info}
 - 先查看有什麼user
 ```
 cat /etc/passwd
 ```
 - 針對要添加的user查詢其UID,以jms-dev為例
 ```
 id jms-dev
 ```
 以下操作均在容器內下指令！
```
# 創建 系統user (容器內)，務必要下此指令，重坑! --2024/04/16 By Kevin
useradd -u 1003 jms-dev

# 創建 虛擬FTP user，並歸屬在實體linux下的使用者jms-dev (容器內)
pure-pw useradd unityftp -f /etc/pure-ftpd/pureftpd.passwd -m -u jms-dev -d /var/download

# 切換 user 與系統關聯的 user (容器內)
pure-pw usermod unityftp -u jms-dev

# 確認與查看 user 資訊(容器內)
pure-pw show unityftp

# 完成添加user後，載入設定 (容器內)
pure-pw mkdb

# 重啓服務 (容器內)
service pure-ftpd restart

# 修改密碼指令，創建user時就會配置，非必要不需再重新配置 (容器內)
pure-pw passwd unityftp

# 增加client 連線數上限 (容器內)
echo 10 > /etc/pure-ftpd/conf/MaxClientsNumber
# 增加IP  連線數上限 (容器內)
echo 10 > /etc/pure-ftpd/conf/MaxClientsPerIP
```

4. 排查指令
查看當前 ftp 連線中用戶 `pure-ftpwho`  (容器內)