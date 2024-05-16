#!/bin/bash

# 设置 Cloudflare API URL
API_URL='https://api.cloudflare.com/client/v4/graphql'

# 设置 Cloudflare 认证信息
AUTH_EMAIL='top****s@gmail.com'
AUTH_KEY='c6b51870241c***d*****9bc98'

zoneTag=("c646c804387a676cfc5d70559e3820b7")


# 获取当前时间并将其减去N小时
past_datetime=$(date -u -d '-7 minutes' +"%Y-%m-%dT%H:%M:00Z")
current_datetime=$(date -u -d '-7 minutes' +"%Y-%m-%dT%H:%M:59Z")

for zoneTag in "${zoneTag[@]}"; do
# 设置请求数据，将datetime_geq和datetime_leq替换为当前时间

domain=$(curl -X GET "https://api.cloudflare.com/client/v4/zones/$zoneTag" \
     -H "Content-Type: application/json" \
     -H "X-Auth-Key: c6*******a9fd6c19bc98" \
     -H "X-Auth-Email: top******il.com" 2>/dev/null | jq -r '.result.name')

REQUEST_DATA='{
  "query": "{ viewer { zones(filter: {zoneTag: $zoneTag}) { httpRequests1mGroups(limit: 10000, orderBy: [sum_bytes_DESC], filter: { datetime_geq: $past_datetime, datetime_leq: $current_datetime }) { sum { bytes } } } } }",
  "variables": { "zoneTag": "'$zoneTag'","current_datetime": "'$current_datetime'", "past_datetime": "'$past_datetime'" }
}'

# 执行 Curl 请求并将输出重定向到文件
response=$(curl --location "$API_URL" \
  --header "X-Auth-Email: $AUTH_EMAIL" \
  --header "X-Auth-Key: $AUTH_KEY" \
  --header 'Content-Type: application/json' \
  --header 'Cookie: cflb=0H28vgHxwvgAQtjUGUFqYFDiSDreGJnUox66fv44dG9; cfruid=339d64340927a09690c3eb5f1a13c149fb5881d7-1694049913' \
  --data "$REQUEST_DATA" 2>/dev/null)
#| jq  | grep bytes | awk -F ': ' -v zoneTag="$zoneTag" '{print zoneTag": " $2 " bytes"}')

bytes=$(echo "$response" | jq -r '.data.viewer.zones[0].httpRequests1mGroups[0].sum.bytes // 0')
megabytes=$(echo "scale=2; $bytes / (1024 * 1024)" | bc)
formatted_megabytes=$(printf "%.2f" "$megabytes")

echo "$formatted_megabytes" > "/etc/zabbix/zabbix_agent2.d/CloudFlare_moniter/data/${domain}_data.txt"

done