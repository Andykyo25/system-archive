#!/usr/bin/env bash
# -----------------------------------
# Script name   : nginx logs status code monitor
# -----------------------------------

LOG_PATH=/var/gb/logs/access.log                                # Nginx日志路径
LOG_TEMP=/etc/zabbix/zabbix_agent2.d/nginx_log/nginx_last_min.log  # Nginx上一分钟文件
LAST_MIN=$(date -d '1 minute ago' "+%Y-%m-%d %H:%M")             # 获取上一分钟值

tail -30000 "${LOG_PATH}" | grep "${LAST_MIN}" > "${LOG_TEMP}"  # tail 3万行数据然后进行过滤上一分钟，如果请求量较大则加大行数，过滤后将数据重定向到上一分钟文件中

# 找到非200状态码且以"-api"结尾的行，并同时打印出对应的-api
cnon200_apis=$(awk '$3 != 200 && $3 != 201  &&  $5 ~ /-api$/{print $3, $5}' "${LOG_TEMP}")

# 打印出非200状态码的数量
cnon200=$(echo "${cnon200_apis}" | wc -l)
[ -z "${cnon200}" ] && cnon200=0

# 输出非200状态码的数量和对应的-api
echo "${cnon200_apis}" : "${cnon200}"