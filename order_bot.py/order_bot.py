import discord
from discord.ext import commands
import json
import os

# 機器人前綴和Token
BOT_PREFIX = "!"
TOKEN = "MTI1OTc2MDkyNTgwMDQwMjk2NA.Gi-ZFe.bAiun25MtuIV8PaFRS9lKF-IBrbka7xGjStmls"

# 設置機器人意圖
intents = discord.Intents.default()
intents.messages = True  # 啟用接收消息的意圖

# 初始化機器人
bot = commands.Bot(command_prefix=BOT_PREFIX)

# 訂單文件
ORDER_FILE = "orders.json"

# 檢查訂單文件是否存在，如果不存在則創建
if not os.path.exists(ORDER_FILE):
    with open(ORDER_FILE, 'w') as f:
        json.dump([], f)

# 訂單數據結構
class Order:
    def __init__(self, order_id, user, product, quantity):
        self.order_id = order_id
        self.user = user
        self.product = product
        self.quantity = quantity

    def to_dict(self):
        return {
            "order_id": self.order_id,
            "user": self.user,
            "product": self.product,
            "quantity": self.quantity
        }

# 添加訂單指令
@bot.command(name="add_order")
async def add_order(ctx, order_id: str, product: str, quantity: int):
    user = ctx.author.name
    new_order = Order(order_id, user, product, quantity)

    # 讀取現有訂單
    with open(ORDER_FILE, 'r') as f:
        orders = json.load(f)

    # 添加新訂單
    orders.append(new_order.to_dict())

    # 保存訂單
    with open(ORDER_FILE, 'w') as f:
        json.dump(orders, f, indent=4)

    await ctx.send(f"訂單已添加：\n訂單ID: {order_id}\n產品: {product}\n數量: {quantity}")

# 查詢訂單指令
@bot.command(name="list_orders")
async def list_orders(ctx):
    with open(ORDER_FILE, 'r') as f:
        orders = json.load(f)

    if not orders:
        await ctx.send("目前沒有訂單。")
        return

    order_list = "\n".join([f"訂單ID: {o['order_id']}, 用戶: {o['user']}, 產品: {o['product']}, 數量: {o['quantity']}" for o in orders])
    await ctx.send(f"訂單列表：\n{order_list}")

# 啟動機器人
bot.run(TOKEN)
