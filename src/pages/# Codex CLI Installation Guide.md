# Codex CLI Installation Guide

## Quick Installation

### Option 1: Install via npm (Recommended)
```bash
npm install -g @openai/codex-cli
```

### Option 2: Install via pip
```bash
pip install codex-cli
```

### Option 3: Download Binary
1. Visit [GitHub Releases](https://github.com/openai/codex-cli/releases)
2. Download the latest release for your platform
3. Extract and add to your PATH

## Post-Installation Setup

### 1. Verify Installation
```bash
codex --version
```

### 2. Configure Authentication
```bash
codex auth login
```

### 3. Test Basic Functionality
```bash
codex --help
```

## Configuration in Kiro

After installing Codex CLI, you can configure it in VS Code settings:

1. Open VS Code Settings (Ctrl/Cmd + ,)
2. Search for "kiro codex"
3. Configure the following options:
   - **Codex Path**: Path to the codex executable (default: "codex")
   - **Default Approval Mode**: How Codex should handle code changes
   - **Default Model**: AI model to use (default: "gpt-5")
   - **Timeout**: Maximum execution time in milliseconds

## Troubleshooting

If you encounter issues, try:

1. **Check PATH**: Ensure codex is in your system PATH
2. **Permissions**: Make sure you have execute permissions
3. **Network**: Verify internet connectivity for authentication
4. **Logs**: Check the Kiro output channel for detailed error messages

For more help, visit: https://docs.openai.com/codex-cli/installation