# Craft Family Design System (CFDS) v1.0

---

## 1. 产品架构与定位 (Product Architecture)

Craft 家族软件分为两大系列，共享底层设计语言，但在氛围渲染上有所区分。

### 1.1 Efficiency Series (效率系列)

**核心理念**：极简、克制、无干扰、高性能。

**代表应用**：MarkCraft (写作)，FlashCraft (记忆)，NoteCraft (错题/笔记)。

**视觉基调**：高对比度的黑白灰主色调，配合标志性的“Craft Yellow”作为高亮引导。

### 1.2 Life Series (生活系列)

**核心理念**：流动、沉浸、温度、感知。

**代表应用**：WeatherCraft (气象)，LifeCraft (习惯/待办)。

**视觉基调**：在黑白基调上，允许使用自然渐变、玻璃拟态、流体动画，强调“氛围感”。

---

## 2. 视觉基础 (Visual Foundation)

所有 Craft 软件必须严格遵守以下 CSS/Tailwind 配置。

### 2.1 色彩系统 (Color Palette)

*   **Craft Black (`#171717`)**: 用于主按钮、Logo 背景、强强调文字。
*   **Craft White (`#ffffff`)**: 用于卡片背景、日间模式底色。
*   **Craft Gray (`#f5f5f7`)**: 全局应用背景色（App Background）。
*   **Craft Yellow (`#facc15`)**: 品牌识别色。用于高亮、Logo 图标、Loading 动画、选中态。
*   **Craft Border (`#e5e5e5`)**: 极细边框颜色。

**差异化配色**:

*   **Life 系列特权**：可以使用 Blue (`#3b82f6`) 或 Warm Orange 渐变作为情绪表达，但必须保持克制。

### 2.2 排版 (Typography)

*   **UI 字体 (Sans)**: Inter (Google Fonts) 或系统默认。**权重**：300 (Light)，400 (Regular)，600 (SemiBold)，700 (Bold)。
*   **代码/数据字体 (Mono)**: JetBrains Mono。用于代码块、统计数字、日期时间、徽标 (Badges)。

### 2.3 阴影与圆角 (Radius & Shadows)

**圆角 (Radius)**:

*   外层容器/Modal: `rounded-3xl` (24px) 或 `rounded-[32px]`。
*   内部卡片/按钮: `rounded-xl` (12px) 或 `rounded-2xl`。

**阴影 (Shadows)**:

*   悬浮态: `shadow-2xl` + `scale-105`。
*   静止态: `shadow-sm` 或 `border border-black/5`。

---

## 3. 核心交互与动画 (Interaction & Motion)

Craft 系列的灵魂在于其独特的动效物理引擎。所有应用必须包含以下动画。

### 3.1 进场动画 (The "Blur-Clear" Entrance)

应用加载或模态框出现时，严禁直接闪现。必须使用“从模糊到清晰”的过渡。

*   **类名**: `.animate-blur-in`
*   **效果**: `filter: blur(10px) -> 0; opacity: 0 -> 1; scale: 0.95 -> 1;`

### 3.2 待机动画 (The "Gentle Float")

主要元素（如 Logo、引导卡片、空状态图标）必须有轻微的呼吸感或漂浮感。

*   **类名**: `.animate-float`
*   **效果**: `transform: translateY(0) -> translateY(-8px) -> translateY(0);` (周期 4s-6s)

### 3.3 交互反馈 (Micro-interactions)

*   **按钮点击**：必须有 `active:scale-95`。
*   **成功操作**：必须触发 `canvas-confetti` (五彩纸屑)，颜色需匹配当前系列（Efficiency 用黑/黄，Life 用白/彩）。
*   **Toast 通知**：底部居中，黑色胶囊状，带图标，进入时上浮渐显。

---

## 4. 标准组件库 (Standard Components)

### 4.1 顶部导航栏 (Header)

*   **布局**：左右布局。左侧 Logo + App Name，右侧工具栏。
*   **样式**：`h-16`，`backdrop-blur-md`，`bg-white/80` (磨砂玻璃)，`border-b border-gray-200`。
*   **Logo**：32x32px 圆角矩形，背景色根据模式变化（Efficiency: 黑底白字; Life: 根据状态变化）。

### 4.2 用户引导层 (The Guide Overlay)

*   **地位**：强制性组件。首次进入 App 必须展示。
*   **样式**：全屏模糊背景 (`backdrop-blur-sm`)。
*   **内容**：
    1.  居中悬浮卡片 (`animate-float`)。
    2.  大尺寸 Logo 旋转展示。
    3.  简短介绍 + 功能列表 (Icon + Title + Desc)。
    4.  “开始探索” 黑色长按钮。
*   **退出**：点击开始后，引导层淡出，主界面执行 Blur-Clear 进场。

### 4.3 设置模态框 (Settings Modal)

*   **触发**：只有点击 Header 右上角的齿轮图标触发。
*   **样式**：`dialog` 元素，白色圆角卡片，`shadow-2xl`。
*   **必须包含**：
    *   “纸张/主题” 切换 (Grid 布局)。
    *   “关于” 信息。

### 4.4 导出/加载结果 (Export Result)

当生成 PDF/图片时，必须隐藏 loading 圈，展示一个带有大图标的“文件处理完成”卡片，并带有“点击下载”的黑色药丸按钮。

---

## 5. 统一技术栈配置 (Implementation Guide)

让 AI 生成代码时，请直接投喂以下配置，确保风格统一。

### Tailwind Config (复用模板)

```javascript
tailwind.config = {
  darkMode: 'class', // 支持暗色模式
  theme: {
    extend: {
      colors: {
        craft: {
          black: '#171717', // 主黑
          gray: '#f5f5f7',  // 背景灰
          yellow: '#facc15',// 品牌黄
          border: '#e5e5e5',// 边框
          text: '#1d1d1f'   // 正文黑
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Menlo', 'monospace'],
      },
      animation: {
        'blur-in': 'blurIn 0.8s cubic-bezier(0.16, 1, 0.3, 1) forwards',
        'float': 'float 6s ease-in-out infinite',
        'scale-in': 'scaleIn 0.2s ease-out forwards',
      },
      keyframes: {
        blurIn: {
          '0%': { filter: 'blur(12px)', opacity: '0', transform: 'scale(0.95)' },
          '100%': { filter: 'blur(0)', opacity: '1', transform: 'scale(1)' }
        },
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-8px)' }
        },
        scaleIn: {
          '0%': { transform: 'scale(0.9)', opacity: '0' },
          '100%': { transform: 'scale(1)', opacity: '1' }
        }
      }
    }
  }
}
```

### 图标库规范

*   统一使用 Lucide React (或 Lucide)。
*   Icon `stroke-width` 统一为 `2px` (常规) 或 `1.5px` (精致感)。


