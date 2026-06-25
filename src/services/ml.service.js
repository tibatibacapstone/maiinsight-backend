import { spawn } from "child_process"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export const runPlaytimeClustering = () => {
  return new Promise((resolve, reject) => {
    const backendRoot = path.resolve(__dirname, "../../")

    const pythonPath =
      process.platform === "win32"
        ? path.join(backendRoot, ".venv", "Scripts", "python.exe")
        : path.join(backendRoot, ".venv", "bin", "python")

    const scriptPath = path.join(backendRoot, "ml", "playtime_clustering.py")

    const child = spawn(pythonPath, [scriptPath], {
      cwd: backendRoot,
      env: process.env,
    })

    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (data) => {
      stdout += data.toString()
    })

    child.stderr.on("data", (data) => {
      stderr += data.toString()
    })

    child.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(stderr || `ML exited with code ${code}`))
      }

      try {
        const lines = stdout.trim().split("\n")
        const lastLine = lines[lines.length - 1]
        const result = JSON.parse(lastLine)

        resolve(result)
      } catch {
        resolve({
          success: true,
          rawOutput: stdout,
        })
      }
    })
  })
}