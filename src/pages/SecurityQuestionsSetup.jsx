import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldCheck, Loader2, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAuth } from '@/lib/AuthContext';
import { saveSecurityQuestions } from '@/services/api';

const QUESTION_BANK = [
  "In what city were you born?",
  "What is the name of your favorite pet?",
  "What is your mother's maiden name?",
  "What high school did you attend?",
  "What was the mascot of your high school?",
  "What was the make of your first car?",
  "What was your favorite toy as a child?",
  "Where did you go on your first vacation?",
  "What is your favorite movie?",
  "What is your favorite food?"
];

export default function SecurityQuestionsSetup() {
  const navigate = useNavigate();
  const { profile, setProfile } = useAuth();

  const [q1, setQ1] = useState("");
  const [a1, setA1] = useState("");
  const [q2, setQ2] = useState("");
  const [a2, setA2] = useState("");
  const [q3, setQ3] = useState("");
  const [a3, setA3] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!q1 || !a1 || !q2 || !a2 || !q3 || !a3) {
      setError("Please select and answer all 3 questions.");
      return;
    }
    if (new Set([q1, q2, q3]).size !== 3) {
      setError("Please select 3 distinct questions.");
      return;
    }

    setLoading(true);
    setError("");

    try {
      await saveSecurityQuestions({ q1, a1, q2, a2, q3, a3 });
      
      // Update local profile state to pass the router guard immediately
      if (setProfile && profile) {
        setProfile({ ...profile, security_questions_setup: true });
      }

      // Navigate to onboarding or dashboard (App.jsx will natively route thanks to auth context)
      navigate('/');
    } catch (err) {
      console.error(err);
      setError(err.message || "Failed to save security questions. Please try again.");
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-blue-50 flex items-center justify-center p-4">
      <div className="max-w-xl w-full">
        <div className="text-center mb-8">
          <div className="w-16 h-16 mx-auto bg-blue-100 rounded-full flex items-center justify-center mb-6 shadow-sm border border-blue-200">
            <ShieldCheck className="w-8 h-8 text-blue-600" />
          </div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight mb-3">Security Questions</h1>
          <p className="text-slate-500 text-sm max-w-sm mx-auto leading-relaxed">
            Please set up your security questions. These will be used to verify your identity if you lose access to your account.
          </p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-slate-200/80 p-8">
          <form onSubmit={handleSubmit} className="space-y-6">
            
            {/* Question 1 */}
            <div className="space-y-3">
              <Label className="text-slate-700 font-semibold uppercase tracking-wider text-xs">Question 1</Label>
              <Select value={q1} onValueChange={(val) => { setQ1(val); setError(""); }}>
                <SelectTrigger className="w-full text-slate-700 bg-slate-50/50">
                  <SelectValue placeholder="Select a question..." />
                </SelectTrigger>
                <SelectContent>
                  {QUESTION_BANK.map((q) => (
                    <SelectItem key={q} value={q} disabled={q === q2 || q === q3}>{q}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                type="text"
                placeholder="Your Answer"
                value={a1}
                onChange={(e) => { setA1(e.target.value); setError(""); }}
                className="h-11"
              />
            </div>

            <div className="h-px bg-slate-100" />

            {/* Question 2 */}
            <div className="space-y-3">
              <Label className="text-slate-700 font-semibold uppercase tracking-wider text-xs">Question 2</Label>
              <Select value={q2} onValueChange={(val) => { setQ2(val); setError(""); }}>
                <SelectTrigger className="w-full text-slate-700 bg-slate-50/50">
                  <SelectValue placeholder="Select a question..." />
                </SelectTrigger>
                <SelectContent>
                  {QUESTION_BANK.map((q) => (
                    <SelectItem key={q} value={q} disabled={q === q1 || q === q3}>{q}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                type="text"
                placeholder="Your Answer"
                value={a2}
                onChange={(e) => { setA2(e.target.value); setError(""); }}
                className="h-11"
              />
            </div>

            <div className="h-px bg-slate-100" />

            {/* Question 3 */}
            <div className="space-y-3">
              <Label className="text-slate-700 font-semibold uppercase tracking-wider text-xs">Question 3</Label>
              <Select value={q3} onValueChange={(val) => { setQ3(val); setError(""); }}>
                <SelectTrigger className="w-full text-slate-700 bg-slate-50/50">
                  <SelectValue placeholder="Select a question..." />
                </SelectTrigger>
                <SelectContent>
                  {QUESTION_BANK.map((q) => (
                    <SelectItem key={q} value={q} disabled={q === q1 || q === q2}>{q}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                type="text"
                placeholder="Your Answer"
                value={a3}
                onChange={(e) => { setA3(e.target.value); setError(""); }}
                className="h-11"
              />
            </div>

            {error && (
              <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg p-3">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <Button
              type="submit"
              disabled={loading}
              className="w-full h-12 bg-[#1a2744] hover:bg-[#243b67] text-white font-semibold rounded-xl mt-4"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Save Security Questions
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
