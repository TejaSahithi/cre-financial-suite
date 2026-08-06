/** @type {import('tailwindcss').Config} */
module.exports = {
    darkMode: ["class"],
    content: ["./index.html", "./src/**/*.{ts,tsx,js,jsx}"],
  theme: {
  	extend: {
  		borderRadius: {
  			lg: 'var(--radius)',
  			md: 'calc(var(--radius) - 2px)',
  			sm: 'calc(var(--radius) - 4px)'
  		},
  		colors: {
  			background: 'var(--bg)',
  			foreground: 'var(--ink)',
  			card: {
  				DEFAULT: 'var(--surface)',
  				foreground: 'var(--ink)'
  			},
  			popover: {
  				DEFAULT: 'var(--surface)',
  				foreground: 'var(--ink)'
  			},
  			primary: {
  				DEFAULT: 'var(--accent)',
  				foreground: '#fff'
  			},
  			secondary: {
  				DEFAULT: 'var(--surface-2)',
  				foreground: 'var(--ink)'
  			},
  			muted: {
  				DEFAULT: 'var(--surface-2)',
  				foreground: 'var(--muted)'
  			},
  			accent: {
  				DEFAULT: 'var(--accent-soft)',
  				foreground: 'var(--ink)'
  			},
  			destructive: {
  				DEFAULT: 'var(--danger)',
  				foreground: '#fff'
  			},
  			border: 'var(--border-cre)',
  			input: 'var(--border-strong)',
  			ring: 'var(--accent)',
  			chart: {
  				'1': 'hsl(var(--chart-1))',
  				'2': 'hsl(var(--chart-2))',
  				'3': 'hsl(var(--chart-3))',
  				'4': 'hsl(var(--chart-4))',
  				'5': 'hsl(var(--chart-5))'
  			},
  			sidebar: {
  				DEFAULT: 'var(--sidebar)',
  				foreground: '#f5f1e7',
  				primary: 'var(--sidebar-active)',
  				'primary-foreground': '#fff',
  				accent: 'var(--sidebar-hover)',
  				'accent-foreground': '#fff',
  				border: 'rgba(255,255,255,.08)',
  				ring: 'var(--accent)'
  			}
  		},
  		keyframes: {
  			'accordion-down': {
  				from: {
  					height: '0'
  				},
  				to: {
  					height: 'var(--radix-accordion-content-height)'
  				}
  			},
  			'accordion-up': {
  				from: {
  					height: 'var(--radix-accordion-content-height)'
  				},
  				to: {
  					height: '0'
  				}
  			}
  		},
  		animation: {
  			'accordion-down': 'accordion-down 0.2s ease-out',
  			'accordion-up': 'accordion-up 0.2s ease-out'
  		}
  	}
  },
  plugins: [require("tailwindcss-animate")],
}
