#!/usr/bin/env bash
Usage(){
    echo -e "$0 脚本使用说明
                -f: 指定要执行的playbook(.yml)文件
                -h: 指定远程主机名（一次只能一台）
                -i: 指定远程主机ip（一次只能一个）
                -u: 指定远程主机的用户,(支持sudo)，默认值为root
                -p: 指定远程主机端口号"
}

cur_dir=$(cd $(dirname ${BASH_SOURCE[0]}); pwd)  #获取当前目录

if [[ $# -eq 0 ]];then
    Usage
    exit 1
elif [[ $1 == "--help" ]];then
    Usage
    exit 2
fi

#1.指定参数赋值
while getopts ":f:h:i:u:p:w:" values;do
  case "$values" in
    "f")
        file="$OPTARG"
        ;;
    "h")
        host="$OPTARG"
        ;;
    "i")
        ip="$OPTARG"
        ;;
    "u")
        user="$OPTARG"
        ;;
    "p")
        port="$OPTARG"
        ;;
    "?")
        echo "无此选项 $OPTARG"
        ;;
    ":")
        echo "此选项无值 $OPTARG"
        ;;
    *)
        Usage
        ;;
    esac
done

# 2.确认参数
if [[ -n ${file} ]];then
    echo -e "
        playbook文件：${file}
        远端主机名:    ${host}
        远端主机IP:    ${ip}
        远端主机用户：${user}
        远端主机端口: ${port}
        "
    echo -e "\033[33m 初始化完后，请务必重启系统...... \033[0m"
    read -p "回车确认执行........." OK
# 3.执行命令
ansible-playbook  ${cur_dir}/${file} --inventory "${host}," --extra-vars "remote_host=${host} ansible_ssh_host=${ip} ansible_ssh_user=${user} ansible_ssh_port=${port}"