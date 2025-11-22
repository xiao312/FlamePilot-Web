#!/usr/bin/env python3
"""
Mock Gemini CLI utility for testing web interface.
Mimics the basic interface of the real Gemini CLI.
"""

import argparse
import sys
import time
import random

def main():
    parser = argparse.ArgumentParser(description='Mock Gemini CLI')
    parser.add_argument('--prompt', '-p', help='Prompt to process')
    parser.add_argument('--model', '-m', help='Model to use (ignored in mock)')
    parser.add_argument('--debug', '-d', action='store_true', help='Debug mode')
    parser.add_argument('--mcp-config', help='MCP config file (ignored in mock)')
    parser.add_argument('--yolo', action='store_true', help='YOLO mode (ignored in mock)')

    args = parser.parse_args()

    # Simulate some processing time
    time.sleep(random.uniform(0.5, 2.0))

    if args.debug:
        print("[DEBUG] Mock Gemini CLI starting", file=sys.stderr)

    if args.prompt:
        # Prepare response chunks beforehand - complete messages like real Gemini CLI
        base_response = f"Mock Gemini response to: '{args.prompt}'"
        if args.model:
            base_response += f" (using model: {args.model})"

        # Output both structured JSON variants for comprehensive testing
        import json

        # Variant 1: File operations
        variant1 = {
            "type": "gemini-response",
            "data": {
                "message": {
                    "content": [
                        {
                            "type": "tool_use",
                            "name": "Read",
                            "id": "tool_read_001",
                            "input": {
                                "file_path": "/path/to/file.txt"
                            }
                        },
                        {
                            "type": "text",
                            "text": "I found the file content. Here are the details:"
                        },
                        {
                            "type": "tool_use",
                            "name": "Write",
                            "id": "tool_write_002",
                            "input": {
                                "file_path": "/path/to/output.txt",
                                "content": "New file content"
                            }
                        },
                        {
                            "type": "text",
                            "text": base_response
                        }
                    ]
                }
            }
        }

        # Variant 2: Mixed tool operations
        variant2 = {
            "type": "gemini-response",
            "data": {
                "message": {
                    "content": [
                        {
                            "type": "tool_use",
                            "name": "Bash",
                            "id": "tool_bash_003",
                            "input": {
                                "command": "ls -la",
                                "description": "List directory contents"
                            }
                        },
                        {
                            "type": "text",
                            "text": "Let me check the directory contents first."
                        },
                        {
                            "type": "tool_use",
                            "name": "TodoWrite",
                            "id": "tool_todo_004",
                            "input": {
                                "todos": [
                                    {
                                        "content": "Analyze project structure",
                                        "status": "completed",
                                        "priority": "high",
                                        "id": "task_001"
                                    },
                                    {
                                        "content": "Implement new feature",
                                        "status": "in_progress",
                                        "priority": "medium",
                                        "id": "task_002"
                                    }
                                ]
                            }
                        },
                        {
                            "type": "text",
                            "text": base_response
                        }
                    ]
                }
            }
        }

        # Output both variants
        print(json.dumps(variant1))
        time.sleep(random.uniform(0.5, 1.0))  # Brief pause between variants
        print(json.dumps(variant2))
    else:
        print("Mock Gemini: Hello! Ready to help with mock responses.")

    if args.debug:
        print("[DEBUG] Mock Gemini CLI finished", file=sys.stderr)

if __name__ == '__main__':
    main()