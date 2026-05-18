import json
import subprocess

def call_mcp_tool(tool_name, arguments):
    proc = subprocess.Popen(
        ['.venv/bin/python', 'crypto_exchange_mcp.py'],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env={'MCP_TRANSPORT': 'stdio', 'PYTHONUNBUFFERED': '1'}
    )
    
    # Send initialize
    init_req = {
        "jsonrpc": "2.0",
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "test", "version": "1.0"}
        },
        "id": 1
    }
    proc.stdin.write(json.dumps(init_req) + '\n')
    proc.stdin.flush()
    
    # Read response
    line = proc.stdout.readline()
    # print(f"DEBUG INIT RESP: {line}")
    
    # Send tool call
    tool_req = {
        "jsonrpc": "2.0",
        "method": "tools/call",
        "params": {
            "name": tool_name,
            "arguments": arguments
        },
        "id": 2
    }
    proc.stdin.write(json.dumps(tool_req) + '\n')
    proc.stdin.flush()
    
    # Read response
    line = proc.stdout.readline()
    # print(f"DEBUG TOOL RESP: {line}")
    
    proc.stdin.close()
    proc.wait()
    return json.loads(line)

if __name__ == "__main__":
    # Test with CoinDCX
    res = call_mcp_tool("coindcx_get_market_details", {"params": {}})
    print(json.dumps(res, indent=2))
