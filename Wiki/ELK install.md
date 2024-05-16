# elasticsearch+kibana(使用者密碼登入)
說明：透過elasticsearch部暑時設定帳密，來實現使用者在登入kibana時透過elasticsearch帳密進行登入

# 機器列表
|容器名稱|server|node|
|---|---|---|
|es01|elasticsearch-cluster-1|e1|
|es02|elasticsearch-cluster-2|e2|
|es03|elasticsearch-cluster-3|e3|
|root-kibana|kibana|c|



# elasticsearch 叢集
# 部署流程
## 建立docker-network
```yml
vi overlay_create.sh
sh overlay_create.sh
```
### Tabs {.tabset}

#### overlay_create.sh 
```yml
#!/usr/bin/env bash


network_NAME='swarm_es'

# --attachable 允许通过docker run的容器接入此overlay网络
docker network create \
    --attachable \
    -d overlay \
    --subnet=10.200.0.0/16 \
    ${network_NAME}
```



## 部署 net(redis)
> 這邊部署reidis，是為了讓node能運作前面建立net集群網路，無實際做資料庫用途
{.is-info}
```yml
vi net.yml
docker stack deploy -c net.yml net
```
### Tabs {.tabset}

#### net.yml 
```yml
version: "3.3"

networks:
  swarm_es:
    external: true

services:

  net-1:
    image: redis:5.0.7
    networks:
      - swarm_es
    hostname: rd-1
    deploy:
      placement:
        # 部署在指定的节点
        constraints:  [node.labels.elk == 1]
      restart_policy:
        condition: on-failure

  net-2:
    image: redis:5.0.7
    networks:
      - swarm_es
    hostname: rd-2
    deploy:
      placement:
        # 部署在指定的节点
        constraints:  [node.labels.elk == 2]
      restart_policy:
        condition: on-failure

  net-3:
    image: redis:5.0.7
    networks:
      - swarm_es
    hostname: rd-3
    deploy:
      placement:
        # 部署在指定的节点
        constraints:  [node.labels.elk == 3]
      restart_policy:
        condition: on-failure
```




## 部署elasticsearch(es01)
```yml
建立對應檔案跟資料夾
mkdir -p /var/qp/data/es01/data
mkdir -p  /var/qp/logs/es01
vi /var/env/qp/config/es01.yml
vi /var/env/qp/config/elasticsearch.yml
#下載檔案後複製至該路徑
cp /tmp/elastic-certificates.p12 /var/env/qp/config/elastic-certificates.p12
# 部屬容器
docker-compose -f es01.yml up -d
```
### elastic-certificates.p12

### Tabs {.tabset}

#### es01.yml 
```yml
version: '2.2'
services:
  es01:
    image: docker.elastic.co/elasticsearch/elasticsearch:7.17.2
    container_name: es01
    restart: always
    environment:
      - "ES_JAVA_OPTS=-Xms512m -Xmx512m"
      - ELASTIC_USERNAME=elastic #設定es帳號
      - ELASTIC_PASSWORD=123456  #設定es密碼
      - xpack.security.enabled=true
      - xpack.security.transport.ssl.enabled=true
    ulimits:
      memlock:
        soft: -1
        hard: -1
    volumes:
      - /var/qp/data/es01/data:/usr/share/elasticsearch/data
      - /var/env/qp/config/elasticsearch.yml:/usr/share/elasticsearch/config/elasticsearch.yml
      - /var/env/qp/config/elastic-certificates.p12:/usr/share/elasticsearch/config/elastic-certificates.p12
      - /var/qp/logs/es01:/usr/share/elasticsearch/logs
    ports:
      - 9200:9200
      - 9300:9300
    networks:
      - swarm_es
networks:
  swarm_es:
    external: true
```

#### elasticsearch.yml
```yml
cluster.name: elas-2
node.name: es01
node.master: true
node.data: true
path.data: /usr/share/elasticsearch/data
path.logs: /usr/share/elasticsearch/logs
bootstrap.memory_lock: true
network.host: 0.0.0.0
http.port: 9200
transport.tcp.port: 9300
discovery.zen.ping.unicast.hosts: ["es01", "es02", "es03"]
discovery.zen.minimum_master_nodes: 2
cluster.initial_master_nodes: es01

http.cors.enabled: true
http.cors.allow-origin: "*"

#xpack.security.enabled: false
#xpack.security.transport.ssl.enabled: false
xpack.security.enabled: true
xpack.security.transport.ssl.enabled: true
xpack.security.transport.ssl.verification_mode: certificate
xpack.security.transport.ssl.keystore.path: elastic-certificates.p12
xpack.security.transport.ssl.truststore.path: elastic-certificates.p12
```

## 部署elasticsearch(es02)
```yml
建立對應檔案跟資料夾
mkdir -p /var/qp/data/es02/data
mkdir -p  /var/qp/logs/es02
vi /var/env/qp/config/es02.yml
vi /var/env/qp/config/elasticsearch.yml
#下載檔案後複製至該路徑
cp /tmp/elastic-certificates.p12 /var/env/qp/config/elastic-certificates.p12
# 部屬容器
docker-compose -f es02.yml up -d
```
### elastic-certificates.p12

### Tabs {.tabset}

#### es02.yml 
```yml
version: '2.2'
services:
  es02:
    image: docker.elastic.co/elasticsearch/elasticsearch:7.17.2
    container_name: es02
    restart: always
    environment:
      - "ES_JAVA_OPTS=-Xms512m -Xmx512m"
      - ELASTIC_USERNAME=elastic #設定es帳號
      - ELASTIC_PASSWORD=123456  #設定es密碼
      - xpack.security.enabled=true
      - xpack.security.transport.ssl.enabled=true
    ulimits:
      memlock:
        soft: -1
        hard: -1
    volumes:
      - /var/qp/data/es02/data:/usr/share/elasticsearch/data
      - /var/env/qp/config/elasticsearch.yml:/usr/share/elasticsearch/config/elasticsearch.yml
      - /var/env/qp/config/elastic-certificates.p12:/usr/share/elasticsearch/config/elastic-certificates.p12
      - /var/qp/logs/es02:/usr/share/elasticsearch/logs
    ports:
      - 9200:9200
      - 9300:9300
    networks:
      - swarm_es
networks:
  swarm_es:
    external: true
```


#### elasticsearch.yml
```yml
cluster.name: elas-2
node.name: es02
node.master: true
node.data: true
path.data: /usr/share/elasticsearch/data
path.logs: /usr/share/elasticsearch/logs
bootstrap.memory_lock: true
network.host: 0.0.0.0
http.port: 9200
transport.tcp.port: 9300
discovery.zen.ping.unicast.hosts: ["es01", "es02", "es03"]
discovery.zen.minimum_master_nodes: 2
cluster.initial_master_nodes: es01

http.cors.enabled: true
http.cors.allow-origin: "*"

#xpack.security.enabled: false
#xpack.security.transport.ssl.enabled: false
xpack.security.enabled: true
xpack.security.transport.ssl.enabled: true
xpack.security.transport.ssl.verification_mode: certificate
xpack.security.transport.ssl.keystore.path: elastic-certificates.p12
xpack.security.transport.ssl.truststore.path: elastic-certificates.p12
```
## 部屬elasticsearch(es03)
```yml
建立對應檔案跟資料夾
mkdir -p /var/qp/data/es03/data
mkdir -p  /var/qp/logs/es03
vi /var/env/qp/config/es03.yml
vi /var/env/qp/config/elasticsearch.yml
#下載檔案後複製至該路徑
cp /tmp/elastic-certificates.p12 /var/env/qp/config/elastic-certificates.p12
# 部屬容器
docker-compose -f es03.yml up -d
```
### elastic-certificates.p12

### Tabs {.tabset}

#### es03.yml 
```yml
version: '2.2'
services:
  es03:
    image: docker.elastic.co/elasticsearch/elasticsearch:7.17.2
    container_name: es03
    restart: always
    environment:
      - "ES_JAVA_OPTS=-Xms512m -Xmx512m"
      - ELASTIC_USERNAME=elastic     #設定es帳號
      - ELASTIC_PASSWORD=123456      #設定es密碼
      - xpack.security.enabled=true
      - xpack.security.transport.ssl.enabled=true
      #- ELASTIC_PASSWORD=kaka10114
    ulimits:
      memlock:
        soft: -1
        hard: -1
    volumes:
      - /var/qp/data/es03/data:/usr/share/elasticsearch/data
      - /var/env/qp/config/elasticsearch.yml:/usr/share/elasticsearch/config/elasticsearch.yml
      - /var/env/qp/config/elastic-certificates.p12:/usr/share/elasticsearch/config/elastic-certificates.p12
      - /var/qp/logs/es03:/usr/share/elasticsearch/logs
    ports:
      - 9200:9200
      - 9300:9300
    networks:
      - swarm_es
networks:
  swarm_es:
    external: true
```

#### elasticsearch.yml
```yml
cluster.name: elas-2
node.name: es03
node.master: true
node.data: true
path.data: /usr/share/elasticsearch/data
path.logs: /usr/share/elasticsearch/logs
bootstrap.memory_lock: true
network.host: 0.0.0.0
http.port: 9200
transport.tcp.port: 9300
discovery.zen.ping.unicast.hosts: ["es01", "es02", "es03"]
discovery.zen.minimum_master_nodes: 2
cluster.initial_master_nodes: es01

http.cors.enabled: true
http.cors.allow-origin: "*"

#xpack.security.enabled: false
#xpack.security.transport.ssl.enabled: false
xpack.security.enabled: true
xpack.security.transport.ssl.enabled: true
xpack.security.transport.ssl.verification_mode: certificate
xpack.security.transport.ssl.keystore.path: elastic-certificates.p12
xpack.security.transport.ssl.truststore.path: elastic-certificates.p12
```
## 驗證es集群
```yml
 ## --user 帳號:密碼
 curl -X GET  --user elastic:123456 "localhost:9200/_cat/nodes?v=true&pretty"
```
```yml
 ## 檢查集群健康狀態
 ## --user 帳號:密碼
 curl -X GET  --user elastic:123456 'http://localhost:9200/_cluster/health'
```


## 部署kibana
```yml
#建立kibana配置檔
vi /var/env/qp/config/kibana.yml
#建立kibana docker-compose yml檔
vi  docker-kibana.yml
docker-compose -f docker-kibana.yml up -d
 
```

### Tabs {.tabset}

#### docker-kibana.yml
```yml
version: "3.3"
services:
  kibana:
    image: kibana:7.17.2 # 8.3.1 # 7.17.2
    environment: 
      ELASTICSEARCH_HOSTS: "http://es01:9200"
    volumes:
      - /var/env/qp/config/kibana.yml:/usr/share/kibana/config/kibana.yml 
    ports:
      - 5601:5601
    networks:
      - swarm_es
networks:
  swarm_es:
    external: true
```
#### kibana.yml
```yml
#
# ** THIS IS AN AUTO-GENERATED FILE **
#

# Default Kibana configuration for docker target
server.host: "0.0.0.0"
server.shutdownTimeout: "5s"
elasticsearch.hosts: [ "http://elasticsearch:9200" ]
monitoring.ui.container.elasticsearch.enabled: true
xpack.security.enabled: true
elasticsearch.username: "elastic"
elasticsearch.password: "123456"
```
# kibana index定時清理設定
## 進入Index Lifecycle Policies管理頁面
```yml
點擊 <Stack-manage>
```

```yml
點擊 <Index Lifecycle Policies>
```

## 建立 Policies
```yml
點擊 <creat policy>
```
```yml
點擊 <垃圾桶圖示> >> 將default關閉改自訂義 >> 設定保留天數
```
> 假設這邊設定30天， index 達到30天時，自動建立新的 Index 來放新進來的，確保資料一直無限的增長下去
{.is-info}


```yml
頁面最下方會有Delete phase 模塊
設定 index保留天數
```
> 假設這邊設定1天，Hot phase觸發後，會產生新的index，舊的index會再1天後被刪除
{.is-info}


## 引用index
```yml
回到Index Lifecycle Policies 點擊剛剛建立的policy，最右側會有個 <+> 符號
```
```yml
引用 index templete
```










