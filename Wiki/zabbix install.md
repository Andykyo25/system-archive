# 監控現行版本
1.Zabbix Server: 5.4.10
2.Zabbix Proxy:  5.4.10
3.Zabbix Agent: zabbix_Agent2
4.Grafana: 8.4.0

# 監控安裝流程

## Zabbix-Server

### 如果主機之前已安裝過 zabbix-server 在更新時要先將舊的移除 

1. 確認 zabbix-server 的容器名稱
```bash
dokcer ps
```

2. 停止 zabbix-server 所有關聯的容器
```bash
# 指令用法: docker stop {"容器名稱"}
docker stop zabbix-server-mysql
docker stop zabbix-web-nginx-mysql
docker stop zabbix-mysql
```

3. 刪除 zabbix-server 所有關聯的容器
```bash
# 指令用法: docker rm {"容器名稱"}
docker rm zabbix-server-mysql
docker rm zabbix-web-nginx-mysql
docker rm zabbix-mysql
```

### 安裝 zabbix-server
1. 使用root權限用戶
```bash
sudo su -
```
2. 在 var 路徑建立zabbix資料夾
```bash
mkdir -p /var/zabbix/deploy/zabbix-server /var/zabbix/conf/zabbix-server /var/zabbix/data/
```
3. 在 /var/zabbix/conf/zabbix-server 內建立 zabbix_server.conf 並添加內容 [conf](#zabbix-server-conf)
```bash
vi /var/zabbix/conf/zabbix-server/zabbix_server.conf
```
4. 在 /var/zabbix/deploy/zabbix-server 內建立 docker-compose.yml 並添加內容 [yaml](#zabbix-server-yaml) 
```bash
vi /var/zabbix/deploy/zabbix-server/docker-compose.yml
```
5. 部屬zabbix-server
```bash
cd /var/zabbix/deploy/zabbix-server/
docker-compose up -d
```
6. 將 IP 以及 hostname 提供給監控組即可完成

## Zabbix-Proxy

### 如果主機之前已安裝過 zabbix-proxy 在更新時要先將舊的移除 

1. 確認 zabbix-proxy 的容器名稱
```bash
dokcer ps
```

2. 停止 zabbix-proxy 容器
```bash
# 指令用法: docker stop {"容器名稱"}

docker stop zabbix-proxy
```

3. 刪除 zabbix-proxy 容器
```bash
# 指令用法: docker rm {"容器名稱"}

docker rm zabbix-proxy
```

### 安裝 zabbix-proxy
1. 使用root權限用戶
```bash
sudo su -
```
2. 在 var 路徑建立zabbix資料夾
```bash
mkdir -p /var/zabbix/deploy/zabbix-proxy /var/zabbix/conf/zabbix-proxy
```
3. 在 /var/zabbix/conf/zabbix-proxy 內建立 zabbix_proxy.conf 並添加內容 [conf](#zabbix-proxy-conf)
```bash
vi /var/zabbix/conf/zabbix-proxy/zabbix_proxy.conf
```
4. 在 /var/zabbix/deploy/zabbix-proxy 內建立 docker-compose.yml 並添加內容 [yaml](#zabbix-proxy-yaml) 
```bash
vi /var/zabbix/deploy/zabbix-proxy/docker-compose.yml
```
5. 確認op用戶名稱
```bash
less /etc/passwd | grep op
>
operator:x:11:0:operator:/root:/sbin/nologin
jms-op:x:1002:1002:jms-op:/home/jms-op:/bin/bash
jms-superop:x:1003:1003:jms-superop:/home/jms-superop:/bin/bash
```
> 如果沒有jms-op用戶，則確認是否有op,ops用戶
{.is-info}
6. 將 /var/zabbix/ 資料夾調整為jms-op用戶權限
```bash
# 指令用法:  chown -R {"用戶名稱"}:{"群組名稱"} {"資料夾路徑"}
chown -R jms-op:jms-op /var/zabbix/
```
7. 確認 jms-op 用戶有無 docker 權限
```bash
id jms-op 
> uid=1010(jms-op) gid=1011(jms-op) groups=1011(jms-op),994(docker)
備註： 994(docker) 表示有權限，且如果數字不是994是正常的，這串數字表示這台機器上docker群組的ID
```
> 確認有權限則跳到第 9 步驟
{.is-info}
8. jms-op 用戶新增 docker 權限
```bash
# jms-op用戶添加docker權限
usermod -aG docker jms-op

# 切換jms-op用戶
su jms-op

# 確認有無docker權限
id
```
9. 部屬zabbix-proxy
`**注意：需切換到 jms-op 用戶部屬容器，部屬完後在切回 root 用戶**`
```bash
# 切換制 jms-op 用戶
su jms-op

# 進入yaml資料夾
cd /var/zabbix/deploy/zabbix-proxy/

# 部屬zabbix-proxy容器
docker-compose up -d

# 跑完確認是否安裝完成，如下圖
docker ps -a | grep zabbix-proxy

# 切回root用戶
exit
```
10. 確認有無舊Zabbix-Proxy檔案並移除
```bash
# 檢查 root 路徑底下有無zabbix-proxy資料夾
ll /root/zabbix-proxy/

# 有資料夾則移除
rm -rf /root/zabbix-proxy/

# 檢查 /etc/zabbix/ 路徑內有無zabbix_proxy.conf檔
ll /etc/zabbix/zabbix_proxy.conf

# 有該conf檔則移除
rm -f /etc/zabbix/zabbix_proxy.conf
```
11. 將 IP 以及 hostname 提供給監控組即可完成

## Zabbix-Agent2

### 如果主機之前已安裝過 zabbix-agent1 在安裝 zabbix-agent2 後要將舊的移除

1. 確認 zabbix-agent1 的套件名稱
```bash
yum list installed | grep zabbix
```

2. 移除 zabbix-agent1 
```bash
# 指令用法: yum remove {"套件名稱"}
yum remove zabbix-agent.x86_64 -y
```

### 安裝 Zabbix-Agent2

1. 登入 root 用戶
```bash
sudo su -
```
2. 下載 zabbix-agent2 套件
```bash
rpm -Uvh https://repo.zabbix.com/zabbix/5.4/rhel/7/x86_64/zabbix-agent2-5.4.10-1.el7.x86_64.rpm 
```
承 2. 如果安裝機器沒有外網安裝 zabbix-agent2 套件方式
```bash
a. 到 zabbix 套件庫下載 rpm 檔
b. 將 rpm 檔放到宿主機的 tmp 目錄下
c. 登入宿主機切換 root，移動到 tmp 目錄，指令：cd /tmp/
d. 執行安裝指令，指令：
rpm -ivh zabbix-agent2-5.4.10-1.el7.x86_64.rpm

補充：官方 zabbix 套件庫下載網址
https://repo.zabbix.com/zabbix/5.4/rhel/7/x86_64/zabbix-agent2-5.4.10-1.el7.x86_64.rpm
```

3. 將 /etc/zabbix/zabbix_agent2.conf 預設內容清空
```bash
> /etc/zabbix/zabbix_agent2.conf
```
4. 依照範例修改 [/etc/zabbix/zabbix_agent2.conf](#zabbix_agent2_conf)
```bash
vi /etc/zabbix/zabbix_agent2.conf
```
> 如果安裝 agent2 的主機是 zabbix-proxy 或是 zabbix-server，agent conf 裡面的 ip 請改為主機的內網IP
{.is-danger}

查詢內網 ip 方法
```bash
ip a | grep -E 'eth[0-9]{1}$|ens[0-9]{1,3}$|eno[0-9]{1}$|em[0-9]{1}$|enp[0-9]{1}s[0-9]{1,2}'
>
inet 172.31.39.114/20 brd 172.31.47.255 scope global dynamic eth0
```
5. 如果需要監控Docker服務，zabbix用戶添加docker權限
```bash
# 用戶 Zabbix 負責運行 Agent2 進程，因此需將 Zabbix 用戶加入 Docker 群組，已獲取 docker.sock 的權限
# Zabbix 用戶只有執行 Agent2 進程、 docker 命令的權限
# 用途: 監控 docker 各容器的運行狀況與資源使用狀況
usermod -aG docker zabbix
```
6. 將 /etc/zabbix/ 資料夾調整為jms-op用戶權限()
```bash
# 指令用法:  chown -R {"用戶名稱"}:{"群組名稱"} {"資料夾路徑"}
chown -R jms-op:jms-op /etc/zabbix/
```
7. 啟動 zabbix-agent2
```bash
# 啟用
systemctl start zabbix-agent2.service

# 配置開機自動啟用
systemctl enable zabbix-agent2.service

# 查看狀態，如下圖
systemctl status zabbix-agent2.service
```


## Grafana

### 如果主機之前已安裝過 grafana 在更新時要先將舊的移除

1. 確認 grafana 的容器名稱
```bash
dokcer ps
```

2. 停止 grafana 容器
```bash
# 指令用法: docker stop {"容器名稱"}
docker stop grafana
```

3. 刪除 grafana 容器
```bash
# 指令用法: docker rm {"容器名稱"}
docker rm grafana
```
### 安裝 grafana

1. 使用root權限用戶
```bash
sudo su -
```
2. 在 var 路徑建立grafana資料夾
```bash
mkdir /var/zabbix/deploy/grafana
```
3. /var/grafana/deploy/grafana 底下建立 docker-sompose.yml 並添加內容 [yaml](#grafana-yaml)
```bash
vi /var/zabbix/deploy/grafana/docker-compose.yml
```
4. 部屬Grafana容器
```bash
cd /var/grafana/deploy/grafana/
docker-compose up -d
```
5. 將 IP 以及 hostname 提供給監控組即可完成

# 監控 yaml

## <span id="zabbix-proxy-yaml">Zabbix-Proxy yaml 內容</span>
```bash
version: '3'
services:
    zabbix-proxy:
       restart: always
       image: zabbix/zabbix-proxy-sqlite3:alpine-5.4.10
       network_mode: "host"
       hostname: zabbix-proxy
       container_name: zabbix-proxy
       volumes:
           - /var/zabbix/conf/zabbix-proxy/zabbix_proxy.conf:/etc/zabbix/zabbix_proxy.conf
           - /etc/localtime:/etc/localtime:ro
```

##  <span id="zabbix-proxy-conf">Zabbix-Proxy conf 內容</span>
```bash
Server={"這邊放 Zabbix-Server IP"}
ServerPort={"火牆開的端口"}
ProxyMode=0
Hostname={"這邊寫宿主機的 Hostname"}
CacheSize=1024M
LogType=console
DBName=/var/lib/zabbix/zabbix_proxy_db
ExternalScripts=/usr/lib/zabbix/externalscripts
FpingLocation=/usr/sbin/fping
Fping6Location=/usr/sbin/fping6
SSHKeyLocation=/var/lib/zabbix/ssh_keys
SSLCertLocation=/var/lib/zabbix/ssl/certs/
SSLKeyLocation=/var/lib/zabbix/ssl/keys/
SSLCALocation=/var/lib/zabbix/ssl/ssl_ca/
LoadModulePath=/var/lib/zabbix/modules/
StartPollers=300
StartPollersUnreachable=80
HousekeepingFrequency=8
```

## <span id="zabbix-server-yaml">Zabbix-Server yaml 內容</span>
```bash
version: "3.5"
services:
   zabbix-mysql:
     image: mariadb:10.5.13
     command: [mysqld,--max_connections=1000, --character-set-server=utf8, --collation-server=utf8_bin, --default-authentication-plugin=mysql_native_password]
     container_name: zabbix-mysql
     restart: always
     ports:
       - '3306:3306'
     environment:
       MYSQL_ROOT_PASSWORD: zabbix
       MYSQL_DATABASE: zabbix
       MYSQL_USER: zabbix
       MYSQL_PASSWORD: zabbix
     volumes:
       - /var/zabbix/data/mysql:/var/lib/mysql
       - /etc/localtime:/etc/localtime:ro

   zabbix-web-nginx-mysql:
     image: zabbix/zabbix-web-nginx-mysql:alpine-5.4.10
     container_name: zabbix-web-nginx-mysql
     restart: always
     environment:
       DB_SERVER_HOST: zabbix-mysql
       MYSQL_DATABASE: zabbix
       MYSQL_USER: zabbix
       MYSQL_PASSWORD: zabbix
       MYSQL_ROOT_PASSWORD: zabbix
       ZBX_SERVER_HOST: zabbix-server-mysql
       PHP_TZ: Asia/Shanghai
     volumes:
       - /etc/localtime:/etc/localtime:ro
     ports:
       - '80:8080'
       - '443:8443'
     links:
       - zabbix-mysql
       - zabbix-server-mysql
     depends_on:
       - zabbix-mysql
       - zabbix-server-mysql

   zabbix-server-mysql:
     image: zabbix/zabbix-server-mysql:alpine-5.4.10
     container_name: zabbix-server-mysql
     restart: always
     environment:
       ZBX_CACHESIZE: 2048M
       DB_SERVER_HOST: zabbix-mysql
       MYSQL_DATABASE: zabbix
       MYSQL_USER: zabbix
       MYSQL_PASSWORD: zabbix
       MYSQL_ROOT_PASSWORD: zabbix
     volumes:
      - /etc/localtime:/etc/localtime:ro
      - /var/zabbix/conf/zabbix-server/zabbix_server.conf:/etc/zabbix/zabbix_server.conf:rw
      - /var/zabbix/data/alertscripts:/usr/lib/zabbix/alertscripts:ro
      - /var/zabbix/data/externalscripts:/usr/lib/zabbix/externalscripts:ro
      - /var/zabbix/data/export:/var/lib/zabbix/export:rw
      - /var/zabbix/data/modules:/var/lib/zabbix/modules:ro
      - /var/zabbix/data/enc:/var/lib/zabbix/enc:ro
      - /var/zabbix/data/ssh_keys:/var/lib/zabbix/ssh_keys:ro
      - /var/zabbix/data/mibs:/var/lib/zabbix/mibs:ro
      - /var/zabbix/data/snmptraps:/var/lib/zabbix/snmptraps:ro
      - /var/zabbix/data/ssl:/var/lib/zabbix/ssl:ro 
     ports:
       - '10051:10051'
     links:
       - zabbix-mysql
     depends_on:
       - zabbix-mysql
```

## <span id="zabbix-server-conf">Zabbix-Server conf 內容</span>
```bash
LogType=console
DBHost=zabbix-mysql
DBName=zabbix
DBUser=zabbix
DBPassword=zabbix
DBPort=3306
StartPollers=300
StartPollersUnreachable=80
StartTrappers=30
StartPingers=100
StartDiscoverers=120
CacheSize=1024M
CacheUpdateFrequency=100
StartDBSyncers=16
HistoryCacheSize=1024M
HistoryIndexCacheSize=512M
TrendCacheSize=1024M
ValueCacheSize=1G
AlertScriptsPath=/usr/lib/zabbix/alertscripts
ExternalScripts=/usr/lib/zabbix/externalscripts
FpingLocation=/usr/sbin/fping
Fping6Location=/usr/sbin/fping6
SSHKeyLocation=/var/lib/zabbix/ssh_keys
SSLCertLocation=/var/lib/zabbix/ssl/certs/
SSLKeyLocation=/var/lib/zabbix/ssl/keys/
SSLCALocation=/var/lib/zabbix/ssl/ssl_ca/
LoadModulePath=/var/lib/zabbix/modules/
StartVMwareCollectors=10
VMwareCacheSize=256M
VMwareFrequency=10
VMwarePerfFrequency=60
VMwareTimeout=300
```

## <span id="grafana-yaml">Grafana yaml 內容</span>
```bash
version: '3.6'

services:

  grafana:
    image: grafana/grafana:8.3.5
    container_name: grafana
    ports:
      - "3000:3000"
    volumes:
      - grafana-storage:/var/lib/grafana
      - /etc/localtime:/etc/localtime:ro
    environment:
      - GF_SECURITY_ADMIN_USER=admin
      - GF_SECURITY_ADMIN_PASSWORD=admin
    restart: always
volumes:
    grafana-storage
```

## <span id="zabbix_agent2_conf">Zabbix-Agent2 conf 內容</span>
```bash
PidFile=/var/run/zabbix/zabbix_agent2.pid
LogFile=/var/log/zabbix/zabbix_agent2.log
LogFileSize=2
DebugLevel=3
Server={"這邊放 zabbix-server 或 zabbix-proxy機器內網IP"}
ServerActive={"這邊放 zabbix-server 或 zabbix-proxy 機器內網IP"}
BufferSend=5
BufferSize=100
RefreshActiveChecks=60
Timeout=30
HostnameItem=system.hostname
```
