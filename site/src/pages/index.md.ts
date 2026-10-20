import { markdown, readmeMarkdown } from "../repo";

// 给 Agent 读的版本：对应语言的 README 原文，相对链接改成 GitHub 绝对地址
export const GET = () => markdown(readmeMarkdown("en"));
