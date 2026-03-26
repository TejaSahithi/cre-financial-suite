import { useState, useEffect } from "react";
import { supabase } from "@/lib/supabaseClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Plus } from "lucide-react";

const ROLE_DEFINITIONS = [
  { value: "viewer", label: "Viewer" },
  { value: "manager", label: "Manager" },
  { value: "finance", label: "Finance" },
  { value: "admin", label: "Admin" },
];

export default function UserManagement() {
  const [users, setUsers] = useState([]);
  const [selectedUsers, setSelectedUsers] = useState([]);
  const [filterRole, setFilterRole] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");
  const [search, setSearch] = useState("");

  useEffect(() => {
    fetchUsers();
  }, []);

  async function fetchUsers() {
    const { data } = await supabase.from("users").select("*");
    setUsers(data || []);
  }

  function getStatus(user) {
    if (!user.role) return "no_access";
    if (user.invited) return "invited";
    return "active";
  }

  function getStatusBadge(user) {
    const status = getStatus(user);

    const colors = {
      active: "bg-green-100 text-green-700",
      invited: "bg-yellow-100 text-yellow-700",
      no_access: "bg-red-100 text-red-700",
    };

    const labels = {
      active: "Active",
      invited: "Invited",
      no_access: "No Access",
    };

    return (
      <span className={`px-2 py-1 rounded text-xs ${colors[status]}`}>
        {labels[status]}
      </span>
    );
  }

  async function updateUserRole(userId, role) {
    await supabase.from("users").update({ role }).eq("id", userId);
    fetchUsers();
  }

  function filteredUsers() {
    return users.filter((u) => {
      const matchesSearch =
        u.full_name?.toLowerCase().includes(search.toLowerCase()) ||
        u.email?.toLowerCase().includes(search.toLowerCase());

      const matchesRole =
        filterRole === "all" || u.role === filterRole;

      const status = getStatus(u);
      const matchesStatus =
        filterStatus === "all" || status === filterStatus;

      return matchesSearch && matchesRole && matchesStatus;
    });
  }

  return (
    <div className="p-6">
      {/* HEADER */}
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold">User Management</h2>

        <div className="flex gap-2">
          <Button>
            <Plus className="w-4 h-4 mr-2" />
            Invite User
          </Button>

          <Button variant="outline">Upload CSV</Button>
        </div>
      </div>

      {/* FILTER BAR */}
      <div className="flex gap-3 mb-4">
        <Input
          placeholder="Search users..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-60"
        />

        <Select value={filterRole} onValueChange={setFilterRole}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Role" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Roles</SelectItem>
            {ROLE_DEFINITIONS.map((r) => (
              <SelectItem key={r.value} value={r.value}>
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={filterStatus} onValueChange={setFilterStatus}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="invited">Invited</SelectItem>
            <SelectItem value="no_access">No Access</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* BULK ACTIONS */}
      {selectedUsers.length > 0 && (
        <div className="flex items-center gap-2 mb-3">
          <span>{selectedUsers.length} selected</span>

          <Button size="sm">Assign Role</Button>
          <Button size="sm" variant="outline">
            Resend Invite
          </Button>
          <Button size="sm" variant="destructive">
            Remove
          </Button>
        </div>
      )}

      {/* TABLE */}
      <table className="w-full border rounded-lg">
        <thead className="bg-gray-50 text-sm">
          <tr>
            <th className="p-3">
              <Checkbox />
            </th>
            <th className="text-left p-3">Name</th>
            <th className="text-left p-3">Email</th>
            <th className="text-left p-3">Role</th>
            <th className="text-left p-3">Status</th>
            <th className="text-left p-3">Last Active</th>
            <th className="text-left p-3">Actions</th>
          </tr>
        </thead>

        <tbody>
          {filteredUsers().map((user) => (
            <tr key={user.id} className="border-t group hover:bg-gray-50">
              <td className="p-3">
                <Checkbox
                  checked={selectedUsers.includes(user.id)}
                  onCheckedChange={(checked) => {
                    setSelectedUsers((prev) =>
                      checked
                        ? [...prev, user.id]
                        : prev.filter((id) => id !== user.id)
                    );
                  }}
                />
              </td>

              <td className="p-3">{user.full_name}</td>
              <td className="p-3">{user.email}</td>

              {/* ROLE */}
              <td className="p-3">
                <Select
                  value={user.role || "none"}
                  onValueChange={(val) =>
                    updateUserRole(user.id, val === "none" ? null : val)
                  }
                >
                  <SelectTrigger className="w-40">
                    <SelectValue placeholder="Assign Role" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No Role</SelectItem>
                    {ROLE_DEFINITIONS.map((r) => (
                      <SelectItem key={r.value} value={r.value}>
                        {r.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </td>

              {/* STATUS */}
              <td className="p-3">{getStatusBadge(user)}</td>

              {/* LAST ACTIVE */}
              <td className="p-3">
                {user.last_active || "Never logged in"}
              </td>

              {/* ACTIONS */}
              <td className="p-3">
                <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition">
                  <Button size="sm" variant="ghost">
                    Edit
                  </Button>
                  <Button size="sm" variant="destructive">
                    Remove
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
