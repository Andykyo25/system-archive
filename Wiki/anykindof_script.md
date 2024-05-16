# 核心腳本分析

## ctn
```bash
#!/usr/bin/env bash
if [ $# -ne 1 ];then
    echo  -e "
        Usage:  $0 {Container_name | Container ID}
        "
    exit 1
fi
docker exec -it $1 /bin/bash
```
> ctn 容器名稱

在使用此腳本後，會先去判斷你有沒有輸入參數
若沒有輸入參數會顯示提示訊息並跳出
參數可以是容器的名稱或ID
判斷到有輸入參數後會執行會後一行的docker指令並進入該容器

路徑:`/usr/bin/`
這個腳本在外圍跟核心都會用到，請務必理解

## count_log
```bash
#!/usr/bin/env bash

# @Time    : 19-3-5 上午11:30
# @Author  : Tim
# @Site    : ${SITE}
# @File    : ${NAME}.py
# @Software: PyCharm

## 核心c上统计a的ngx日志
#
echo -n 'wait...'
## 截取三十分钟日志
_befor=$(date -d '-30 minutes' "+%F %T")
_now=$(date "+%F %T")
awk -F '\\[|\\]' -v _befor="${_befor}" -v _now="${_now}" '$2 > _befor && $2 < _now{print $0}' /var/log/nginx/core-ngx-a/access.log > /tmp/count_log.tmp

# --------------------------------------------------
echo '
统计三十分钟, 各站点 .html 请求数量
'

awk -F'|' '{print $1}'  /tmp/count_log.tmp |
awk  '/\.html/{
    print substr($5,0,5)"_"$(NF-1)
}'  | \
    sort | uniq -c | sort -n | tail -20

# --------------------------------------------------
echo '
统计三十分钟内单个外围最多uri
'
awk -F'|' '{print $1}'  /tmp/count_log.tmp | \
awk '(/\.html/ && $0 !~ /(mcenter|boss)/){print $7"_"$(NF-1)}' | \
sort | uniq -c | sort -n | tail -20
```
執行後會擷取`/var/log/nginx/core-ngx-a/access.log`前30分鐘的日誌到`/tmp/count_log.tmp`
後續會根據站點或外圍作統計跟排序，個別印出
![count_log.png](/gb-pic/count_log.png)

路徑:`/usr/local/bin`
這個腳本在外圍跟核心C上都有，但有些許的不同可以自行去比對

## rectn
```bash
#!/usr/bin/env bash


if [ $# -ge 2 ] ; then
    FILTER="$1"
    shift
    CMD="$@"
else
    echo '请检查参数'
    exit 1
fi


if docker ps --format '{{.Names}}'  --filter name=$FILTER &> /dev/null; then
    C_LIST=$(docker ps --format '{{.Names}}' --filter name=$FILTER)
    for C_NAME in $C_LIST; do
        echo "---- ${C_NAME}:"
        docker exec  $C_NAME $CMD
    done
else
    echo '找不到容器'
    exit 2
fi
```
> rectn 容器名稱 執行指令

此腳本是可以直接在容器外下指令，不用再進到容器裡

一開始會先判斷輸入的參數有沒有兩個以上
第一個為容器名稱
第二個之後的是要在容器執行的指令

後續第二個判斷是判斷有沒有該容器名稱
有的話就執行docker指令，沒有就跳出

路徑:`/usr/local/bin`

## live-reload-ngx.sh
```bash
#!/usr/bin/env bash

# by sun 简单快速重启nginx
for i in `docker ps |grep live_line-in |awk '{print $NF}'`;do rectn $i reload-ngx;done
```
這個是針對nginx容器做快速reload的腳本
用迴圈搭配docker ps撈出核心所有的nginx容器
再利用上面提到的 `rectn` 腳本直接對每個nginx容器做reload的動作
h-reload-ngx.sh這個腳本也是相同的道理

> 目前nginx容器只放在`核心R跟核心T`裡面，如果要執行請先確認容器在哪個核心
{.is-info}

路徑:`/usr/local/bin`

## reload-ngx.sh
```bash
#!/usr/bin/env bash
# Author: Sun @2020.02.18
# Usage: $0 (live|h|v)

if [[ $# -ne 1  ]];then
    echo -e "Usage:
                $0 [live_line-in | h_line-in | v_line-in | t_api-ngx | t_pay-ngx]\n"
    exit 0
else
    docker ps | grep "${1}"  > /dev/null
    if [[ $? -ne 0 ]];then
        echo "No container_name: ${1}"
        exit 1
    fi
fi


for container_name in `docker ps | grep "${1}" | awk '{print $NF}'`;do
    docker exec ${container_name} reload-ngx
done
```
> reload-ngx.sh live_live-in

這個腳本跟 `live-reload-ngx.sh` 一樣都是reload nginx
差別只在它可以根據輸入的容器名稱將對應的線路全部重啟，而不是一個腳本只能重啟一個線路

第一個判斷，判斷是否有輸入參數(容器名稱)，沒有就會跳出
如果有輸入參數後面會判斷是否有這個容器

都正確才會執行後面的迴圈抓出該線路所有的nginx容器，做reload的動作

> 目前nginx容器只放在`核心R跟核心T`裡面，如果要執行請先確認容器在哪個核心
{.is-info}

路徑:`/var/gb/script`

---
`/var/env/gb/live/script`此路徑底下的多為發包腳本
因為目前發包大多從大魚上執行
這邊介紹平常會遇到需要手動重啟服務的腳本

## service_stop_new.sh
```bash
#!/usr/bin/env bash
# -*- coding:utf-8 -*-

# Author: Tim
#
cur_dir_com="$( cd $(dirname ${BASH_SOURCE[0]}) && pwd )"
# 导入脚本所在目录下存在函数功能文件function.sh，
source ${cur_dir_com}/function.sh

host=$1
shift
work_host="${username}@${host}:${port}"

for app in $@;do
    (
        dubbo_off=$(get_dubbo_off $app)
        container=$(get_container_name $host $app)

        if [[ $h_line == True ]];then
            pssh_cmd="rectn ${container}  ${dubbo_off}"
        elif [[ $v_line == True ]];then
            pssh_cmd="rectn ${container}  ${dubbo_off}"
        else
            pssh_cmd="rectn ${container}  ${dubbo_off}"
        fi

        pssh_with_info

    ) &
    sleep 1
done
wait
```
腳本的開頭會先引入已寫好的函式文件 `function.sh`
透過裡面的 `get_dubbo_off` 跟 `get_container_name` 兩支函示獲取服務的容器名稱跟關閉dubbo的指令
進而把要執行的指令存進 `pssh_cmd` 變數
再由 `pssh_with_info` 遠程到對應的核心節點執行docker指令

## tomcat_stop_start_new.sh
```bash
#!/usr/bin/env bash
# -*- coding:utf-8 -*-

# Author: Tim
#
cur_dir="$( cd $(dirname ${BASH_SOURCE[0]}) && pwd )"
# 导入项目变量
source $cur_dir/_variable.sh

# 导入脚本所在目录下存在函数功能文件function.sh，
source ${cur_dir}/function.sh

# 判断脚本是
case $1 in
    stop|close|c)
        commad="stop.sh"
        shift
        ;;
    start|open|o)
        commad="start.sh"
        shift
        ;;
    *)
        echo  Userage:  $0  ' <o|c>  <HOST>  <APP> [APP2]..'
        exit 1
        ;;
esac

host=$1
shift
work_host="${username}@${host}:${port}"

#
for app in $@;do
  (
    container=$(get_container_name $host $app)
    if [[ $h_line == True ]];then
        pssh_cmd="rectn ${container}  ${commad}"
    elif [[ $v_line == True ]];then
        pssh_cmd="rectn ${container}  ${commad}"
    else
        pssh_cmd="rectn ${container} ${commad}"
    fi
    pssh_with_info
  ) &
    sleep 1
done
wait

sleep 3
echo "
     查看容器 tomcat 进程 < Bootstrap > 状态：
"
for app in $@;do
    container=$(get_container_name $host $app)
    echo --------------- $container ---------------
    if [[ $h_line == True ]];then
        pssh -H $work_host -i "rectn ${container} jps"
    elif [[ $v_line == True ]];then
        pssh -H $work_host -i "rectn ${container} jps"
    else
        pssh -H $work_host -i "rectn ${container} jps"
    fi
done
wait
```
前面會先判斷輸入的參數是start還是stop，來決定執行的指令是 `start.sh` 或 `stop.sh`
再來的迴圈會判斷抓取到的服務容器名稱是哪個線路(正式、測試、灰度)
進而把要執行的指令存進 `pssh_cmd` 變數
一樣由 `pssh_with_info` 遠程到對應的核心節點執行docker指令

最後一個迴圈判斷哪個線路之後會透過 `docker jps` 的指令確認容器的狀態

## 02-APP-service.sh
```bash
#!/usr/bin/env bash
#Usage: $0  目标主机 应用包+

cur_dir=$(cd $(dirname ${BASH_SOURCE[0]}); pwd )
source $cur_dir/color-to-node.sh
source $cur_dir/_variable.sh

# 使用帮助

# 键入回车确认等待
_enter_go_on(){
    _h2 "-----------------------------------------"
    read -p "        请按回车继续..." var
    _h2 "-----------------------------------------"
}

_enter_ok_go_on(){
unset ok
while [[ ! "$ok" == "ok" ]]; do
    read -p "请输入'ok' ,按回车继续：" ok
done
}


ITEM=1
# ============= 反注册dubbo，停止tomcat start ===============
_h2 "[ Step ${ITEM} ]: 反注册 APP 的 dubbo 服务..."; let ITEM+=1
_enter_ok_go_on
source $cur_dir/service_stop_new.sh $@
sleep 15s


_h2 "[ Step ${ITEM} ]: 停止tomcat... "; let ITEM+=1

_enter_ok_go_on
source $cur_dir/tomcat_stop_start_new.sh stop $@


_h2 "[ Step ${ITEM} ]: 开启tomcat...  $@"; let ITEM+=1
_enter_go_on
source $cur_dir/tomcat_stop_start_new.sh start $@
```

> 02-APP-service.sh a節點 重啟的服務

`_enter_go_on` 跟 `_enter_ok_go_on` 兩個函式定義了Enter繼續跟輸入OK繼續的流程
後續流程就由上面兩支腳本
`service_stop_new.sh` 關閉dubbo
`tomcat_stop_start_new.sh` 關閉以及開啟服務的tomcat

P.S:這邊是以正式線腳本作範例，其餘線路都是相同的概念

### 備註

`color-to-node.sh` 定義顯示文字顏色樣式
`function.sh`      定義好的函示庫
`_variable.sh`     定義好的變數

有許多發包的腳本都有引入上述幾支腳本，可以去看一下就不多做說明

---
底下介紹核心crontab會執行的腳本
/etc/corntab

## os_check.sh
此腳本是用來檢測核心相關監控項巡檢
在crontab裡有設定每天早上9點會自動執行一次

```bash
#!/usr/bin/env bash
# Author: Sun
# Date: 2020/3/13 11:34
# Description: 适用于核心机房相关监控项巡检
[ $(id -u) -gt 0 ] && echo "please used the root or sudo " && exit 1

cur_dir=$(cd $(dirname ${BASH_SOURCE[0]}); pwd )
source $cur_dir/color-to-node.sh

curr_hostname=`hostname`
cur_time=`date "+%Y%m%d"`

if [[ ! -d $cur_dir/tmp  ]];then
  mkdir $cur_dir/tmp
fi

if [[ ! -d $cur_dir/result  ]];then
  mkdir $cur_dir/result
fi
```

開頭有做限制，只能用root用戶跟sudo執行此腳本
並判斷當前路徑底下有無`tmp`跟`result`資料夾，如果沒有會自行創建

```bash
function main() {
  # 执行流程
  # echo -e "\033[45;37m 紫底白字 \033[0m"
  echo -e "主机 | 巡检项 | 检查状态 | 状态信息" > ${cur_dir}/result/InspectionRecord-${cur_time}.log
  get_cpu
  get_mem
  get_disk
  check_crontab
  check_command
  check_boot
  check_root_denyLogin
  check_sudoers
  check_authorized_keys
  check_auditd
  check_login
  check_superuser
  check_empty_passwd_user
  check_env
  check_ssh_deny
  get_time
  # 判断主机巡检
  if [[ $curr_hostname == "r1" ]];then
    check_connection_syncServer
  fi
  if  [[ $curr_hostname == "NFS-1" ]];then
    check_png_zip_process
  fi
  if [[ $curr_hostname == "c" ]];then
    check_process_isNot_active lsyncd
    check_process_isNot_active vsftpd
    check_crontab_alarm "/var/env/gb/live/script/count_alarm.sh" "30分钟html请求大于1万告警"
    check_crontab_alarm "/var/env/gb/live/script/count_five_alarm.sh" "5分钟的登录和注册大于300告警"
    check_crontab_alarm "/var/env/gb/live/script/redis/redis-check.sh" "核心机房redis监控"
    check_container_sum
  fi
}
```

這邊是此腳本的主要流程，由底下許多的涵式組成
並根據不同的核心主機做判斷去執行不同的監控項目

```bash
function check_crontab() {
  # 检测本机crontab文件md5值和init值比对是否一致
  file="${cur_dir}/tmp/crontab.md5"
  if [[ ! -f $file ]];then
    touch $file
    md5sum /etc/crontab >$file
    md5sum -c $file &>/dev/null
  else
    md5sum -c $file &>/dev/null
  fi

  if [ $? -eq 0 ];then
    print_info ${curr_hostname} 检查crontab内容是否发生更改 OK 无
  else
    print_info ${curr_hostname} 检查crontab内容是否发生更改 FAILED 和初始文件的md5值不一致,请手动查看
  fi
}
```
這邊以`check_crontab`舉例

`check_crontab`
`check_command`
`check_boot`
`check_sudoers`
`check_authorized_keys`
`check_env`
以上六支涵式檢測項目都有在`tmp`資料夾底下各有一份md5初始值
會先判斷有無初始值，沒有的話會計算md5值存入文件
有的話會根據此初始值判斷有無更改過文件

```bash
function print_info() {
  # 自定义echo内容
  # $1: 主机
  # $2: 巡检项
  # $3: 检查状态
  # $4: 异常信息
  echo "$1 | $2 | $3 | $4" >> ${cur_dir}/result/InspectionRecord-${cur_time}.log
}
```

`print_info`這隻涵式會在其他涵式被呼叫，用來印出結果資訊並匯入`result`資料夾底下的log

```bash
function check_used() {
  # 依据阀值设置,进行标记严重程度

  item=$1                    # 检测项
  value=${2:-0}              # 检测项的值
  critical=${3:-0}           # 临界值

  if [[ ${value%.*} -ge ${critical%.*} ]]; then
    #_error "当前主机 ${curr_hostname} ${item} 使用率大于等于${critical} 检测过高"
    print_info ${curr_hostname} ${item}负载/使用率 FAILED 使用率大于等于${critical}检测过高
  elif [[ ${value%.*} -lt ${critical%.*} ]]; then
    #_success "${item}使用率"
    print_info ${curr_hostname} ${item}负载/使用率 OK 无
  else
    print_info ${curr_hostname} ${item} FAILED 检测有误,请手动查看
  fi

}
```

`check_used`此涵式主要檢測CPU、記憶體、跟硬碟項目
判斷檢測出來的當前值是否大於等於臨界值，是否過高
以及判斷檢測出的當前值有無異常情況需要手動查看

其餘的function可以去看一下腳本內容，大多都是指令加上判斷

## os_all_check.sh
此腳本一樣是用來檢測核心相關監控項巡檢
在crontab裡有設定每天早上9點10分會自動執行一次
```bash
#!/usr/bin/env bash

today_time=$(date "+%Y%m%d")
ansible c,r,a,t -m shell -a 'column -t -s "|" /var/gb/script/InspectionBash/result/InspectionRecord-$(date "+%Y%m%d").log' > /var/log/InspectionRecord/InspectionRecord-${today_time}.log

# 告警发送到大鱼 gb平台
alert_info=$(cat /var/log/InspectionRecord/InspectionRecord-${today_time}.log | grep "FAILED")
if [ -n "$alert_info" ]; then
    curl -k -X POST -d \
    '{"hostname":"'$HOSTNAME'",
     "message":"`核心机房日常巡检异常事件项` \n\n '"$alert_info"'",
     "channel":"core",
     "platform":"gb",
     "message_level":5,
     "remarkable":true,
     "confirmable":true}' \
     --header "Content-Type:application/json" https://gb.dayu-boss.com:1399/api?m=message
fi
```

會根據核心各個服務器 a、c、r、t，由`os_check.sh`腳本印出結果資訊
並匯入`/var/gb/script/InspectionBash/result/`資料夾底下的log
彙整後存入`/var/log/InspectionRecord/`底下加上當天日期成一份新的log
後續再抓取這份log是否有FAILED資訊，來判斷哪一台核心服務器有異常並回傳到大魚上做告警

## count_alarm.sh
此腳本是用來檢測html請求是否大於10000
在crontab裡有設定每30分鐘會自動執行一次
```bash
#!/usr/bin/env bash

# 核心c上统计a的ngx日志

# 截取三十分钟日志
_befor=$(date -d '-30 minutes' "+%F %T")
_now=$(date "+%F %T")
awk -F '\\[|\\]' -v _befor="${_befor}" -v _now="${_now}" '$2 > _befor && $2 < _now{print $0}' /var/log/nginx/core-ngx-a/access.log > /tmp/count_call-police.log

# --------------------------------------------------
count_site=`awk -F'|' '{print $1}'  /tmp/count_call-police.log | awk  '/\.html/{print substr($5,0,5)"_"$(NF-1)}' | sort | uniq -c | sort -n | tail -20 | awk '$1>10000'`

if [ -n "$count_site" ]; then
   curl -k -X POST -d '{"hostname":"'核心机房c--r日志'", "message":"核心机房以下站点30分钟内单个url访问次数超过10000次 疑似被攻击,请立即关注!! \n\n '"$count_site"'","channel":"core","platform":"gb","message_level":5,"remarkable":true,"confirmable":true}' --header "Content-Type:application/json" https://gb.dayu-boss.com:1399/api?m=message 
fi

count_host=`awk -F'|' '{print $1}'  /tmp/count_call-police.log | awk '(/\.html/ && $0 !~ /(mcenter|boss)/){print $7"_"$(NF-1)}' | sort | uniq -c | sort -n | tail -20 | awk '$1>10000'`

if [ -n "$count_host" ]; then
  curl -k -X POST -d '{"hostname":"'核心机房c--r日志'", "message":"核心机房以下外围主机30分钟内单个url访问次数超过10000次 疑似被攻击,请立即关注！！：\n\n '"$count_host"'","channel":"core","platform":"gb","message_level":5,"remarkable":true,"confirmable":true}' --header "Content-Type:application/json" https://gb.dayu-boss.com:1399/api?m=message
fi
```

開頭會獲取往前推算30分鐘r上的日誌並匯出到`/tmp/count_call-police.log`
後續會根據站點或外圍作統計跟排序，個別做判斷如果請求大魚10000次即會在大魚顯示告警

## count_five_alarm.sh
此腳本是用來針對註冊請求是否大於300
在crontab裡有設定每5分鐘會自動執行一次
```bash
#!/usr/bin/env bash

# @Author  : kane

# 核心c上统计a的ngx日志

# 截取五分钟日志
_now=$(date "+%F %T")
_5befor=$(date -d '-5 minutes' "+%F %T")
awk -F '\\[|\\]' -v _befor="${_5befor}" -v _now="${_now}" '$2 > _befor && $2 < _now{print $0}' /var/log/nginx/core-ngx-a/access.log > /tmp/fiveMinutes_count_log

#------------------------------------大于300告警 注册的站点
# uri:"/register/playerRegister.html"
count1_registery_site=`awk -F'|' '{print $1}'   /tmp/fiveMinutes_count_log |  /usr/bin/awk  '/register\/playerRegister\.html/{print substr($5,0,5)"_"$(NF-1) }'  |  sort | uniq -c | sort -n | tail -20 | awk '$1>300'`

# uri:"/mobile-api/registerOrigin/save.html"
count2_registery_site=`awk -F'|' '{print $1}'   /tmp/fiveMinutes_count_log |  /usr/bin/awk  '/mobile-api\/registerOrigin\/save\.html/{print substr($5,0,5)"_"$(NF-1) }'  |  sort | uniq -c | sort -n | tail -20 | awk '$1>300'`

# uri: "/signUp/save.html"
count3_registery_site=`awk -F'|' '{print $1}'   /tmp/fiveMinutes_count_log |  /usr/bin/awk  '/signUp\/save\.html/{print substr($5,0,5)"_"$(NF-1) }'  |  sort | uniq -c | sort -n | tail -20 | awk '$1>300'`

if [[ -n "$count1_registery_site" || -n "$count2_registery_site" || -n "$count3_registery_site" ]]; then
    curl -k -X POST -d '{"hostname":"'核心机房c--r日志'", "message":"核心机房以下站点5分钟内注册接口访问次数超过300次 疑似被攻击,请立即关注！！：：\n\n '"$count1_registery_site"' \n\n '"$count2_registery_site"' \n\n '"$count3_registery_site"'","channel":"core","platform":"gb","message_level":5,"remarkable":true,"confirmable":true}' --header "Content-Type:application/json" https://gb.dayu-boss.com:1399/api?m=message
fi

#------------------------------------------------------------------------------------------------------

#------------------------------------大于300告警外围主机
count1_registery_host=`awk -F'|' '{print $1}'  /tmp/fiveMinutes_count_log | awk '(/register\/playerRegister\.html/ && $0 !~ /(mcenter|boss)/){print $7"_"$(NF-1)}' | sort | uniq -c | sort -n | tail -20 | awk '$1>300'`
count2_registery_host=`awk -F'|' '{print $1}'  /tmp/fiveMinutes_count_log | awk '(/mobile-api\/registerOrigin\/save\.html/ && $0 !~ /(mcenter|boss)/){print $7"_"$(NF-1)}' | sort | uniq -c | sort -n | tail -20 | awk '$1>300'`
count3_registery_host=`awk -F'|' '{print $1}'  /tmp/fiveMinutes_count_log | awk '(/signUp\/save\.html/ && $0 !~ /(mcenter|boss)/){print $7"_"$(NF-1)}' | sort | uniq -c | sort -n | tail -20 | awk '$1>300'`

if [[ -n "$count1_registery_host" || -n "$count2_registery_host" || -n "$count3_registery_host" ]]; then
    curl -k -X POST -d '{"hostname":"'核心机房c--r日志'", "message":"核心机房以下主机5分钟内注册接口访问次数超过300次 疑似被攻击,请立即关注！！：：\n\n  '"$count1_registery_host"' \n\n  '"$count2_registery_host"' \n\n  '"$count3_registery_host"'","channel":"core","platform":"gb","message_level":5,"remarkable":true,"confirmable":true}' --header "Content-Type:application/json" https://gb.dayu-boss.com:1399/api?m=message
fi

#------------------------------------登录告警-站点
count_login_site=`awk -F'|' '{print $1}'   /tmp/fiveMinutes_count_log |  /usr/bin/awk  '/\/passport\/login\.html/{print substr($5,0,5)"_"$(NF-1) }'  |  sort | uniq -c | sort -n | tail -20 | awk '$1>300'`

if [ -n "$count_login_site" ]; then
  curl -k -X POST -d '{"hostname":"'核心机房c--r日志'", "message":"核心机房以下站点5分钟内登录接口访问次数超过300次 疑似被攻击,请立即关注！！：： \n\n  '"$count_login_site"'","channel":"core","platform":"gb","message_level":5,"remarkable":true,"confirmable":true}' --header "Content-Type:application/json" https://gb.dayu-boss.com:1399/api?m=message
fi


#------------------------------------登录告警-外围主机
count_login_host=`awk -F'|' '{print $1}'  /tmp/fiveMinutes_count_log | awk '(/\/passport\/login\.html/ && $0 !~ /(mcenter|boss)/){print $7"_"$(NF-1)}' | sort | uniq -c | sort -n | tail -20 | awk '$1>300'`

if [ -n "$count_login_host" ]; then
  curl -k -X POST -d '{"hostname":"'核心机房c--r日志'", "message":"核心机房日志显示以下外围主机5分钟内登录接口访问次数超过 300 次 疑似被攻击,请立即关注！！：：\n\n '"$count_login_host"'","channel":"core","platform":"gb","message_level":5,"remarkable":true,"confirmable":true}' --header "Content-Type:application/json" https://gb.dayu-boss.com:1399/api?m=message
fi

```

跟`count_alarm.sh`是差不多的
只是他根據這三個uri去判斷如果請求大魚10000次即會在大魚顯示告警
`/register/playerRegister.html`
`/mobile-api/registerOrigin/save.html`
`/signUp/save.html`

## redis-check.sh
此腳本是獲取redis資訊傳到zabbix做監控
每5分鐘會執行一次
```bash
#!/usr/bin/env bash
# Author: Sun
# Description : monitor redis and send data to zabbix-server

# -------------------------------------------------------------------------------------------
# IDC1  dt-redis节点 存储数据缓存  ss-redis节点: 存储session数据
# dt-redis-3 dt-redis-4 dt-redis-5 dt-redis-6 dt-redis-7 dt-redis-8 dt-redis-9 dt-redis-10
# ss-redis-3 ss-redis-4 ss-redis-5 ss-redis-6 ss-redis-7 ss-redis-8 ss-redis-9 ss-redis-10
# -------------------------------------------------------------------------------------------

function check_cluster_status(){
    # $1: redis-type (dt|ss)
    # $2: redis-node
    # $3: port
    status=`redis-cli  -c -h $2 -p $3 cluster info | grep "cluster_state" | awk -F ':' '{print $NF}'`
    if echo $status | grep "ok" >/dev/null;then
        zabbix_sender -z 47.56.234.117 -s redis-new -k  ${1}-rd.redis.info.cluster_state -o ${status}
    else
        status="Fail"
        zabbix_sender -z 47.56.234.117 -s redis-new -k  ${1}-rd.redis.info.cluster_state -o ${status}
    fi
}

# redis 集群状态数据上报
check_cluster_status dt 10.10.5.3 6379
check_cluster_status ss 10.10.5.3 6380


function get_data(){
    # $1: redis-type (dt|ss)
    # $2: redis-node
    # $3: port
    # $4: check_key
    # $5: redis-number
    data=`/usr/bin/redis-cli -h ${2} -p ${3} info | grep -w ${4} | awk -F ':' '{print $NF}'`
    /usr/bin/zabbix_sender -z  47.56.234.117 -s redis-new -k ${1}-rd-${5}.redis.info.${4} -o ${data}
}

# keys 注释
#-----------------------------------------------------------
# used_memory:                  Redis使用内存，字节数
# used_memory_human:            redis使用内存 单位G
# connected_clients:            已连接客户端的数量(不包括通过从属服务器连接的客户端)
# instantaneous_input_kbps:     瞬间的Redis输入网络流量(kbps)
# instantaneous_output_kbps:    瞬间的Redis输出网络流量(kbps)
# instantaneous_ops_per_sec:    服务器每秒钟执行的命令数量
# keyspace_misses:              查找键未命中的次数
# evicted_keys:                 因内存used_memory达到maxmemory后，每秒被驱逐的key个数
# expired_keys:                 因为过期而被自动删除的数据库键数量
# rejected_connections:         因连接数达到maxclients上限后，被拒绝的连接个数
#-----------------------------------------------------------

keys="used_memory
      connected_clients
      instantaneous_input_kbps
      instantaneous_output_kbps
      instantaneous_ops_per_sec
      keyspace_misses
      evicted_keys
      expired_keys
      rejected_connections
"

# 获取redis info信息,并发送至zabbix
for i in $(seq 3 10);do
    for key in $keys;do
        get_data  dt 10.10.5.${i} 6379 $key $i
        get_data  ss 10.10.5.${i} 6380 $key $i
    done
done
```

`check_cluster_status` 是用10.10.5.3(a3)的ip抓取dt、ss兩個redis容器裡`cluster_state`這個key的狀態存入status這個變數

`get_data` 則是抓取a3~a10中的redis，還有keys裡邊所有的key，用雙迴圈的方式存素data的變數

上述兩個涵式變數透過`zabbix_sender`指令將核心ss、dt兩個redis容器資訊傳遞到zabbix上
> zabbix_sender -z 服務器IP -s 服務器名稱 -k key -o value
{.is-info}

## domain_alarm.sh
因為67站點已關站，這個是針對此站點下`8hongtu.com`這個域名做監控
每40分鐘會執行一次
```bash
#!/usr/bin/env bash
# Description: 67站点关站，单独监控下这个域名8hongtu.com访问 告警

alarm_value=$(awk '/8hongtu.com/{print "time:"$2" "$3",""uuid:"$5",""hostname:"$7",""url:"$13}' /tmp/count_call-police.log)

if [ -n "$alarm_value" ]; then
   curl -k -X POST -d '{"hostname":"'核心机房c--r日志'", "message":"67站点关站，核心机房出现8hongtu.com域名访问,请立即关注!! \n\n '"$alarm_value"'","channel":"core","platform":"gb","message_level":5,"remarkable":true,"confirmable":true}' --header "Content-Type:application/json" https://gb.dayu-boss.com:1399/api?m=message
fi
```

由`count_alarm.sh`此腳本對r所擷取出來的日誌`/tmp/count_call-police.log`
判斷日誌裡是否有出現該域名，並傳到大魚做告警