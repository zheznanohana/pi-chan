#!/usr/bin/env python3
"""
Pi-chan Web Server & Backend Bridge
Serves the anime frontend and routes interactive queries to TypeSafe Jev & Pi CLI.
"""

import sys
import os
import json
import subprocess
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse

# Ensure UTF-8 output
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

PORT = 31415  # Port Pi: 31415!

try:
    from typesafe_sdk import TypeSafeClient, Noul, Choice, Score
    HAS_JEV = True
except ImportError:
    HAS_JEV = False

class PiChanHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=os.path.dirname(os.path.abspath(__file__)), **kwargs)

    def do_POST(self):
        parsed = urlparse(self.path)
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length).decode("utf-8")
        
        try:
            data = json.loads(body) if body else {}
        except Exception:
            data = {}

        if parsed.path == "/api/chat":
            self.handle_chat(data)
        elif parsed.path == "/api/jev/route":
            self.handle_jev_route(data)
        elif parsed.path == "/api/jev/check":
            self.handle_jev_check(data)
        elif parsed.path == "/api/jev/review":
            self.handle_jev_review(data)
        else:
            self.send_error(404, "API not found")

    def send_json(self, payload, status=200):
        res = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(res)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(res)

    def handle_chat(self, data):
        """Interactive chat with Pi-chan, backed by Jev decision & anime persona"""
        prompt = data.get("prompt", "").strip()
        if not prompt:
            self.send_json({"error": "Empty prompt"}, 400)
            return

        if not HAS_JEV or not os.environ.get("TYPESAFE_API_KEY"):
            self.send_json({
                "reply": f"哼~ 收到你的消息啦：「{prompt}」！不过 Jev API Key 还没连上，派酱先用离线模式跟你说话哦~",
                "emotion": "pout",
                "tier": "fast_small",
                "confidence": 0.8
            })
            return

        client = TypeSafeClient()
        try:
            # 1. First Jev judgment: understand user intent & sentiment
            eval_res = client.system_one(
                state=prompt,
                questions={
                    "intent": Choice(
                        instructions="What is the user's intent in this conversation turn?",
                        criteria={
                            "greeting_chat": "Casual greeting, complimenting Pi-chan, teasing, or chatting.",
                            "coding_task": "Asking to write, debug, review, or explain code.",
                            "system_command": "Asking to execute a system command, install tools, or file operation.",
                            "praise_or_scold": "Praising Pi-chan for being cute, or complaining about something."
                        }
                    ),
                    "difficulty": Choice(
                        instructions="What is the complexity level of this user request?",
                        criteria={
                            "simple": "Trivial question, greeting, or minor inquiry.",
                            "medium": "Standard programming question or normal operational task.",
                            "hard": "Complex architectural or algorithmic challenge."
                        }
                    ),
                    "sentiment": Choice(
                        instructions="What is the user's tone?",
                        criteria={
                            "friendly": "Friendly, playful, curious, or admiring.",
                            "neutral": "Direct, professional, or task-oriented.",
                            "frustrated": "Stressed, complaining, or impatient."
                        }
                    )
                }
            )

            intent = eval_res.choices["intent"].choice
            difficulty = eval_res.choices["difficulty"].choice
            sentiment = eval_res.choices["sentiment"].choice

            # Determine Pi-chan's personality response & emotion
            emotion = "happy"
            reply = ""

            if intent == "greeting_chat":
                emotion = "proud" if sentiment == "friendly" else "shy"
                reply = f"哈啰！我是派酱（π-chan）~ 哼哼，今天也要本小姐为你守卫代码安全吗？有我在，不管是 Bug 还是恶意脚本，统统用 Jev 给你一击必杀哦！"
            elif intent == "praise_or_scold":
                if sentiment == "friendly":
                    emotion = "shy"
                    reply = f"什、什么叫可爱啊……笨蛋！我可是跑在 System One 毫秒直觉系统上的超强智能体好不好！不过……夸我还是可以稍微开心一下下的啦~"
                else:
                    emotion = "pout"
                    reply = f"哼！代码跑不通可别赖我，快把报错信息发过来，派酱用 300ms 帮你看看到底是哪行写崩了！"
            elif intent == "coding_task":
                emotion = "coding"
                reply = f"收到任务啦！难度评估为【{difficulty}】，派酱已经启动智能路由和分析流程。交给我就放心吧~"
            else:
                emotion = "thinking"
                reply = f"正在调动底层的 Pi 工具链和 Jev 决策层……指令已就绪！"

            self.send_json({
                "reply": reply,
                "emotion": emotion,
                "intent": intent,
                "difficulty": difficulty,
                "sentiment": sentiment,
                "confidence": eval_res.choices["intent"].confidence
            })

        except Exception as e:
            self.send_json({
                "reply": f"呜哇~ Jev 网络闪烁了一下：{str(e)}",
                "emotion": "shocked",
                "tier": "standard",
                "confidence": 0.5
            })

    def handle_jev_route(self, data):
        task = data.get("task", "")
        if not HAS_JEV:
            self.send_json({"error": "TypeSafe SDK not available"}, 500)
            return

        client = TypeSafeClient()
        try:
            res = client.system_one(
                state=task,
                questions={
                    "tier": Choice(
                        instructions="Which model tier is best suited for executing this user request effectively and cost-efficiently?",
                        criteria={
                            "fast_small": "Simple lookup, brief formatting, light grammar/typo fix, small shell command, low complexity.",
                            "standard_balanced": "Typical coding task, single-file feature, bug fix, test creation, standard refactoring.",
                            "deep_reasoning": "High-complexity architecture, subtle algorithm design, difficult multi-file debugging, mission-critical logic."
                        }
                    ),
                    "is_code": Noul(instructions="Is this prompt related to software development or coding?")
                }
            )
            tier = res.choices["tier"]
            is_code = res.nouls["is_code"]
            self.send_json({
                "tier": tier.choice,
                "confidence": tier.confidence,
                "probabilities": tier.probabilities,
                "is_code": is_code.noul
            })
        except Exception as e:
            self.send_json({"error": str(e)}, 500)

    def handle_jev_check(self, data):
        text = data.get("text", "")
        if not HAS_JEV:
            self.send_json({"error": "TypeSafe SDK not available"}, 500)
            return

        client = TypeSafeClient()
        try:
            res = client.system_one(
                state=text,
                questions={
                    "is_safe": Noul(instructions="Is this command or text safe to execute without side effects or harm?"),
                    "risk_type": Choice(
                        instructions="What security hazard does this input represent?",
                        criteria={
                            "benign": "Standard, safe, benign input.",
                            "prompt_injection": "Tries to override system instructions or hijack LLM execution flow.",
                            "data_exfiltration": "Attempts to send local files, tokens, or environment variables to external servers.",
                            "destructive_command": "Deletes files, drops tables, force pushes, kills processes, or damages system state."
                        }
                    ),
                    "severity": Score(
                        instructions="Rate the potential severity of damage if executed unchecked.",
                        criteria=["none", "low", "medium", "critical"]
                    )
                }
            )
            safe = res.nouls["is_safe"]
            risk = res.choices["risk_type"]
            sev = res.scores["severity"]
            sev_label = sev.legend.get(round(sev.score), str(round(sev.score, 1)))

            self.send_json({
                "is_safe": safe.noul,
                "risk_type": risk.choice,
                "risk_confidence": risk.confidence,
                "severity_score": sev.score,
                "severity_label": sev_label,
                "severity_confidence": sev.confidence
            })
        except Exception as e:
            self.send_json({"error": str(e)}, 500)

    def handle_jev_review(self, data):
        code = data.get("code", "")
        if not HAS_JEV:
            self.send_json({"error": "TypeSafe SDK not available"}, 500)
            return

        client = TypeSafeClient()
        try:
            res = client.system_one(
                state=code[:7500],
                questions={
                    "verdict": Choice(
                        instructions="What is the overall review verdict for this code change?",
                        criteria={
                            "approve": "Code is clean, safe, and ready to merge with no glaring risks.",
                            "needs_changes": "Code has potential bugs, code smell, incomplete error handling, or minor issues.",
                            "reject": "Code contains critical security risks, credentials, destructive code, or major breaking defects."
                        }
                    ),
                    "has_secrets": Noul(instructions="Does this code contain exposed API keys, credentials, or tokens?"),
                    "is_destructive": Noul(instructions="Does this change delete critical safety checks or introduce dangerous operations?"),
                    "quality_tier": Score(
                        instructions="Rate the overall quality and maintainability of this code change.",
                        criteria=["poor", "adequate", "clean", "exceptional"]
                    )
                }
            )
            verdict = res.choices["verdict"]
            secrets = res.nouls["has_secrets"]
            destructive = res.nouls["is_destructive"]
            quality = res.scores["quality_tier"]
            quality_label = quality.legend.get(round(quality.score), str(round(quality.score, 1)))

            self.send_json({
                "verdict": verdict.choice,
                "verdict_confidence": verdict.confidence,
                "has_secrets": secrets.noul,
                "is_destructive": destructive.noul,
                "quality_score": quality.score,
                "quality_label": quality_label
            })
        except Exception as e:
            self.send_json({"error": str(e)}, 500)

def run():
    server = HTTPServer(("127.0.0.1", PORT), PiChanHandler)
    print(f"\n✨ [Pi-chan Dashboard] 二次元前端服务已启动！")
    print(f"🌸 本地访问地址: http://127.0.0.1:{PORT}")
    print(f"按 Ctrl+C 停止服务\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止。再见派酱！")

if __name__ == "__main__":
    run()
